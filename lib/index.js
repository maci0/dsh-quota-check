/**
 * dsh-quota-check — one statusbar figure for the provider the current session
 * is using: the remaining balance on a pure API-billing route, or the plan
 * quota on a subscription route.
 *
 * Two halves, one endpoint:
 *
 * - this host half owns the provider credential and the outbound request, and
 *   serves one JSON reply from `GET /quota-check?provider=<id>`. That is the
 *   only way a browser half can reach a provider key: the key stays in this
 *   process, and the browser only ever sees the formatted figure.
 * - `lib/client.js` registers the chip in `conversation.composer.dock` — the
 *   statusbar row directly under the composer and its model selector — and
 *   asks this route for the provider the session's model selection names.
 *
 * Which endpoints answer is `probes.ts`; the credential and the reading are
 * resolved once per provider and cached for {@link DEFAULT_CACHE_SECONDS}, so
 * a rerender, a session switch, or a second tab never multiplies provider
 * traffic.
 *
 * @module dsh-quota-check
 */
import Schema from '@deepseek-ai/schemastery';
import { localRequests } from './local-usage.js';
import { resolveProbe } from './probes.js';
import { record } from './util.js';
/** Plugin name as it appears in the loader. */
export const name = 'quota-check';
/** The route carrier is the one service this plugin cannot work without. */
export const inject = ['webServer'];
/** The route the browser half reads. */
export const ROUTE = '/quota-check';
/** Seconds one provider's reading is served without re-asking the provider. */
export const DEFAULT_CACHE_SECONDS = 60;
/** Per-request ceiling for a provider call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Seconds the browser half waits between re-reads, unless configured otherwise. */
export const DEFAULT_REFRESH_SECONDS = 300;
/** Live report entries one host keeps before it starts evicting. */
const MAX_REPORTS = 512;
/**
 * Row schema: what Cordis validates this plugin's `config` against, and where
 * each default lives. Every value here is a deployment choice — the cadences
 * and the deadline vary by machine — so none is a constant only this plugin
 * could change.
 */
export const Config = Schema.object({
    cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS),
    timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS),
    refreshSeconds: Schema.number().min(10).max(3_600).default(DEFAULT_REFRESH_SECONDS),
});
/** Write a JSON reply whose body is already serialized. */
function sendBody(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
}
/** Write a JSON reply; readings are live facts and are never cached by the browser. */
function sendJson(res, status, payload) {
    sendBody(res, status, JSON.stringify(payload));
}
/**
 * Query parameters of a request target.
 *
 * Only the query matters here, so only the query is parsed: building a `URL`
 * for every read pays for an origin the route never looks at.
 * @param url - request target, path and query.
 * @returns the decoded parameters.
 */
function searchParamsOf(url) {
    // The fragment is not part of the request target a `URL` would parse either,
    // and a target whose `#` precedes its `?` must not have the fragment read as
    // query text.
    const hash = url.indexOf('#');
    const target = hash < 0 ? url : url.slice(0, hash);
    const start = target.indexOf('?');
    if (start < 0)
        return new URLSearchParams();
    return new URLSearchParams(target.slice(start + 1));
}
/** The composition's trust fence, when this composition mounts one. */
function connectionOf(ctx) {
    return ctx.get('connection');
}
/**
 * Resolve one provider route's profile: the settings namespace the LLM registry
 * points at, drilled to the route's own path.
 * @param ctx - host context.
 * @param providerId - route id.
 * @returns the fields this plugin reads, empty when nothing resolves.
 */
function providerConfigOf(ctx, providerId) {
    const llm = ctx.get('llm');
    let entry;
    try {
        entry = llm?.listConfigurableProviders().find(candidate => candidate.provider === providerId);
    }
    catch (error) {
        ctx.logger.warn(`quota-check: could not read the provider directory (${String(error)})`);
    }
    if (entry === undefined)
        return {};
    const settings = ctx.get('settings');
    const descriptor = settings?.describe().find(candidate => candidate.ns === entry.settingsNs);
    let section = descriptor?.value;
    for (const segment of entry.settingsPath)
        section = record(section)?.[segment];
    const fields = record(section) ?? {};
    return {
        ...entry.displayName === undefined ? {} : { displayName: entry.displayName },
        ...typeof fields['baseURL'] === 'string' ? { baseURL: fields['baseURL'] } : {},
        ...typeof fields['apiKeyEnv'] === 'string' ? { apiKeyEnv: fields['apiKeyEnv'] } : {},
    };
}
/**
 * Resolve the provider credential: the configured reference first, then the
 * references the probe itself names.
 * @param ctx - host context.
 * @param config - the route's resolved profile.
 * @param envNames - fallback references the probe names.
 * @returns the key, or `undefined` when none is configured.
 */
async function apiKeyOf(ctx, config, envNames) {
    const credentials = ctx.get('credentials');
    for (const ref of [config.apiKeyEnv, ...envNames]) {
        if (ref === undefined || ref.length === 0)
            continue;
        const resolved = await credentials?.resolve(ref);
        const stored = resolved?.value;
        if (stored !== undefined && stored.length > 0)
            return stored;
        const ambient = process.env[ref];
        if (ambient !== undefined && ambient.length > 0)
            return ambient;
    }
    return undefined;
}
/**
 * Build one provider's reading.
 * @param ctx - host context.
 * @param providerId - route id the browser half asked about.
 * @param timeoutMs - per-request provider deadline.
 * @param refreshMs - re-read cadence the browser half is told to use.
 * @returns the report, never throwing: a failure is an `error` report.
 */
async function buildReport(ctx, providerId, timeoutMs, refreshMs) {
    // Resolved per miss, not cached: the miss is network-bound, and a profile
    // cache would hide a settings edit (baseURL, displayName) for its whole TTL.
    const config = providerConfigOf(ctx, providerId);
    const displayName = config.displayName ?? providerId;
    const base = { provider: providerId, displayName, fetchedAt: Date.now(), refreshMs };
    const probe = resolveProbe(providerId, config.baseURL);
    if (probe === undefined) {
        return {
            ...base,
            status: 'unsupported',
            message: 'no balance or quota endpoint is known for this provider',
        };
    }
    const envNames = probe.envNames ?? [];
    try {
        const local = probe.local;
        let requests;
        if (local === undefined) {
            const key = await apiKeyOf(ctx, config, envNames);
            if (key === undefined) {
                return {
                    ...base,
                    status: 'error',
                    message: `no credential is configured for this route (${config.apiKeyEnv ?? envNames.join(' / ')})`,
                };
            }
            if (probe.requests !== undefined) {
                // The endpoint names ids only the provider knows: read its listing
                // first, then ask each one it offers.
                requests = await probe.requests({ key, timeoutMs });
            }
            else if (probe.url === undefined) {
                return { ...base, status: 'error', message: 'this probe declares neither an endpoint nor a listing' };
            }
            else {
                requests = [{ url: probe.url, headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }];
            }
            if (requests.length === 0) {
                return {
                    ...base,
                    status: 'error',
                    message: `${config.baseURL ?? providerId} listed no endpoint to ask`,
                };
            }
        }
        else {
            requests = await localRequests(local, {});
            if (requests.length === 0) {
                return {
                    ...base,
                    status: 'error',
                    message: `no usable ${local} CLI credential is on this machine`,
                };
            }
        }
        let outcome = await fetchAll(requests, timeoutMs);
        // A live-looking token can still be refused: rotate once and retry, which is
        // what the CLI's own fetcher does. Cursor has no refresh path, so a retry
        // there would only repeat the same refused request.
        if (local !== undefined && local !== 'cursor' && !outcome.ok && outcome.refused) {
            const retried = await localRequests(local, { forceRefresh: true });
            if (retried.length > 0)
                outcome = await fetchAll(retried, timeoutMs);
        }
        if (!outcome.ok) {
            return {
                ...base,
                status: 'error',
                message: `${requests[0]?.url ?? providerId} answered HTTP ${String(outcome.status)}`,
            };
        }
        const reading = probe.parse(outcome.payloads);
        if (reading === null) {
            return { ...base, status: 'error', message: 'the provider response carried no balance or quota figure' };
        }
        return {
            ...base,
            status: 'ok',
            kind: probe.kind,
            text: reading.text,
            ...reading.remaining === undefined ? {} : { remaining: reading.remaining },
            lines: reading.lines,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, status: 'error', message };
    }
}
/**
 * Run every request of one probe in order, tolerating a partial answer: Grok
 * reports two meters and one of them may be unavailable, so only a round where
 * nothing answered is a failure.
 * @param requests - requests built from the provider's credential.
 * @param timeoutMs - per-request deadline.
 * @returns the decoded bodies, the last status, and the refusal flag.
 */
async function fetchAll(requests, timeoutMs) {
    const payloads = [];
    let status = 0;
    let refused = false;
    for (const request of requests) {
        try {
            const response = await fetch(request.url, {
                headers: request.headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            status = response.status;
            if (response.status === 401 || response.status === 403)
                refused = true;
            payloads.push(response.ok ? await response.json().catch(() => undefined) : undefined);
        }
        catch {
            payloads.push(undefined);
        }
    }
    return { ok: payloads.some(payload => payload !== undefined), status, refused, payloads };
}
/**
 * Mount the host half.
 * @param ctx - host context carrying the route carrier.
 * @param config - this plugin's row configuration.
 */
export function apply(ctx, config = {}) {
    // The row schema fills every default (even for an omitted row), so the
    // reads below are plain: the schema is the single source of each default.
    const validated = Config(config);
    const cacheSeconds = validated.cacheSeconds;
    const timeoutMs = validated.timeoutMs;
    const refreshMs = validated.refreshSeconds * 1_000;
    const cache = new Map();
    const inflight = new Map();
    /**
     * Keep the report map at its cap: once it holds `MAX_REPORTS`, the oldest key
     * goes before the next insert. `Map` iterates in insertion order, so the first
     * key is the one inserted longest ago; an entry whose lifetime has passed is
     * already a miss on read, so it needs no sweep here.
     */
    const pruneReports = () => {
        if (cache.size < MAX_REPORTS)
            return;
        const oldest = cache.keys().next().value;
        if (oldest !== undefined)
            cache.delete(oldest);
    };
    /**
     * Serve one provider's serialized reading: the cached body, or a fresh one.
     *
     * The body is serialized once, when the reading is taken, so a hit answers
     * with the bytes written then instead of serializing the same report again on
     * every poll.
     */
    const reportFor = (providerId, refresh) => {
        const hit = cache.get(providerId);
        if (!refresh && hit !== undefined && Date.now() - hit.at < cacheSeconds * 1_000) {
            return Promise.resolve(hit.body);
        }
        const running = inflight.get(providerId);
        if (running !== undefined)
            return running;
        const pending = buildReport(ctx, providerId, timeoutMs, refreshMs).then((report) => {
            pruneReports();
            const body = JSON.stringify(report);
            cache.set(providerId, { at: Date.now(), body });
            return body;
        }).finally(() => {
            inflight.delete(providerId);
        });
        inflight.set(providerId, pending);
        return pending;
    };
    const handler = async (req, res) => {
        const rejection = connectionOf(ctx)?.requestRejection(req);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            res.setHeader('allow', 'GET');
            sendJson(res, 405, { status: 'error', message: 'this route answers GET only' });
            return;
        }
        const params = searchParamsOf(String(req.url ?? ROUTE));
        const providerId = params.get('provider') ?? '';
        if (providerId.length === 0) {
            sendJson(res, 400, { status: 'error', message: 'a provider query parameter is required' });
            return;
        }
        const body = await reportFor(providerId, params.get('refresh') === '1');
        sendBody(res, 200, body);
    };
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), `quota-check: GET ${ROUTE}`);
}
