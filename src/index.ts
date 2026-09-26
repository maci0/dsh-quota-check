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

import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { localRequests, type LocalRequest } from './local-usage.ts'
import { resolveProbe } from './probes.ts'
import { record } from './util.ts'
import type {
  ConfigurableProviderLike,
  ConnectionLike,
  CredentialsLike,
  Disposable,
  HostContext,
  LlmRegistryLike,
  RequestLike,
  ResponseLike,
  SettingsDescriptorLike,
} from './host.ts'

/** Plugin name as it appears in the loader. */
export const name = 'quota-check'

/** The route carrier is the one service this plugin cannot work without. */
export const inject = ['webServer']

/** The route the browser half reads. */
export const ROUTE = '/quota-check'

/** Seconds one provider's reading is served without re-asking the provider. */
export const DEFAULT_CACHE_SECONDS = 60

/** Per-request ceiling for a provider call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Seconds the browser half waits between re-reads, unless configured otherwise. */
export const DEFAULT_REFRESH_SECONDS = 300

/** Live report entries one host keeps before it starts evicting. */
const MAX_REPORTS = 512

/**
 * Configuration this plugin's row resolves to, as `apply` receives it.
 *
 * Every field is `volatile()`, so the loader hands a live reference rather than
 * a value: the settings document accepts writes only under a volatile node, and
 * the Plugins page's Quota check card edits exactly these three. Each is read
 * per request, so a save changes the next reading, cache window, and polling
 * cadence without remounting the route.
 */
export interface Config {
  /** Seconds a reading stays cached. `0` re-asks on every request. @default 60 */
  readonly cacheSeconds: Volatile<number>
  /** Per-request provider deadline in milliseconds. @default 10000 */
  readonly timeoutMs: Volatile<number>
  /** Seconds between the browser half's re-reads. @default 300 */
  readonly refreshSeconds: Volatile<number>
}

/** Raw row values, as a profile patch states them and as direct callers pass them. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : Config[K] }

/**
 * Field defaults and bounds with no volatility wrapper. {@link resolveRow}
 * parses a plain row through this schema, so its output is plain values; the
 * loader-facing {@link Config} below is the same shape with every field made
 * `volatile()`. The pair is asserted equal in the suite.
 */
const ValueSchema = Schema.object({
  cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS),
  timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS),
  refreshSeconds: Schema.number().min(10).max(3_600).default(DEFAULT_REFRESH_SECONDS),
})

/**
 * Row schema as Cordis resolves it: what this plugin's `config` is validated
 * against, and where each default lives. Every value here is a deployment
 * choice — the cadences and the deadline vary by machine — so none is a
 * constant only this plugin could change, and all three are editable from the
 * Plugins page.
 */
export const Config = Schema.object({
  cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS).volatile(),
  timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS).volatile(),
  refreshSeconds: Schema.number().min(10).max(3_600).default(DEFAULT_REFRESH_SECONDS).volatile(),
})

/**
 * Read one configured field as a plain value.
 *
 * The loader hands a `volatile()` field a live reference; a direct caller (a
 * test, another plugin composing this one) hands the value itself. Both are
 * accepted, so one read path serves both.
 * @param value - the configured value, live or plain.
 * @returns the current plain value, or `undefined` when a reference holds none.
 */
function readLive<T>(value: T | Volatile<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    // A scalar snapshot is the value; the generic cannot narrow that itself.
    return (value as Volatile<T>).get() as T | undefined
  }
  return value as T | undefined
}

/**
 * Turn a row — live references or plain values — into validated plain options.
 * @param row - the configured row.
 * @returns the resolved options, defaults filled by the schema.
 */
export function resolveRow(row: Config | Options = {}): Required<Options> {
  return ValueSchema({
    cacheSeconds: readLive(row.cacheSeconds),
    timeoutMs: readLive(row.timeoutMs),
    refreshSeconds: readLive(row.refreshSeconds),
  }) as Required<Options>
}

/** One provider's answer, as the browser half reads it. */
export interface QuotaReport {
  /** Route id the report belongs to. */
  readonly provider: string
  /** Display name for the route, when the registry declares one. */
  readonly displayName: string
  /** `ok` renders the figure; `unsupported` and `error` render nothing. */
  readonly status: 'ok' | 'unsupported' | 'error'
  /** Which kind of figure this is, on `ok`. */
  readonly kind?: 'balance' | 'quota'
  /** Compact statusbar text, on `ok`. */
  readonly text?: string
  /** Tooltip detail lines, on `ok`. */
  readonly lines?: readonly string[]
  /** Remaining quota as a percentage, on `ok` when the reading is metered. */
  readonly remaining?: number
  /** Why there is no figure, on `unsupported` and `error`. */
  readonly message?: string
  /** When the reading was taken, epoch milliseconds. */
  readonly fetchedAt: number
  /** How long the browser half should wait before re-reading, in milliseconds. */
  readonly refreshMs: number
}

/** The route's profile fields this plugin reads, resolved from settings. */
interface ProviderConfig {
  readonly displayName?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
}

/** Write a JSON reply whose body is already serialized. */
function sendBody(res: ResponseLike, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Write a JSON reply; readings are live facts and are never cached by the browser. */
function sendJson(res: ResponseLike, status: number, payload: unknown): void {
  sendBody(res, status, JSON.stringify(payload))
}

/**
 * Query parameters of a request target.
 *
 * Only the query matters here, so only the query is parsed: building a `URL`
 * for every read pays for an origin the route never looks at.
 * @param url - request target, path and query.
 * @returns the decoded parameters.
 */
function searchParamsOf(url: string): URLSearchParams {
  // The fragment is not part of the request target a `URL` would parse either,
  // and a target whose `#` precedes its `?` must not have the fragment read as
  // query text.
  const hash = url.indexOf('#')
  const target = hash < 0 ? url : url.slice(0, hash)
  const start = target.indexOf('?')
  if (start < 0) return new URLSearchParams()
  return new URLSearchParams(target.slice(start + 1))
}

/** The composition's trust fence, when this composition mounts one. */
function connectionOf(ctx: HostContext): ConnectionLike | undefined {
  return ctx.get('connection') as ConnectionLike | undefined
}

/**
 * Resolve one provider route's profile: the settings namespace the LLM registry
 * points at, drilled to the route's own path.
 * @param ctx - host context.
 * @param providerId - route id.
 * @returns the fields this plugin reads, empty when nothing resolves.
 */
function providerConfigOf(ctx: HostContext, providerId: string): ProviderConfig {
  const llm = ctx.get('llm') as LlmRegistryLike | undefined
  let entry: ConfigurableProviderLike | undefined
  try {
    entry = llm?.listConfigurableProviders().find(candidate => candidate.provider === providerId)
  } catch (error) {
    ctx.logger.warn(`quota-check: could not read the provider directory (${String(error)})`)
  }
  if (entry === undefined) return {}
  const settings = ctx.get('settings') as { describe(): readonly SettingsDescriptorLike[] } | undefined
  const descriptor = settings?.describe().find(candidate => candidate.ns === entry.settingsNs)
  let section: unknown = descriptor?.value
  for (const segment of entry.settingsPath) section = record(section)?.[segment]
  const fields = record(section) ?? {}
  return {
    ...entry.displayName === undefined ? {} : { displayName: entry.displayName },
    ...typeof fields['baseURL'] === 'string' ? { baseURL: fields['baseURL'] } : {},
    ...typeof fields['apiKeyEnv'] === 'string' ? { apiKeyEnv: fields['apiKeyEnv'] } : {},
  }
}

/**
 * Resolve the provider credential: the configured reference first, then the
 * references the probe itself names.
 * @param ctx - host context.
 * @param config - the route's resolved profile.
 * @param envNames - fallback references the probe names.
 * @returns the key, or `undefined` when none is configured.
 */
async function apiKeyOf(
  ctx: HostContext,
  config: ProviderConfig,
  envNames: readonly string[],
): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  for (const ref of [config.apiKeyEnv, ...envNames]) {
    if (ref === undefined || ref.length === 0) continue
    const resolved = await credentials?.resolve(ref)
    const stored = resolved?.value
    if (stored !== undefined && stored.length > 0) return stored
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient
  }
  return undefined
}

/**
 * Build one provider's reading.
 * @param ctx - host context.
 * @param providerId - route id the browser half asked about.
 * @param timeoutMs - per-request provider deadline.
 * @param refreshMs - re-read cadence the browser half is told to use.
 * @returns the report, never throwing: a failure is an `error` report.
 */
async function buildReport(ctx: HostContext, providerId: string, timeoutMs: number, refreshMs: number): Promise<QuotaReport> {
  // Resolved per miss, not cached: the miss is network-bound, and a profile
  // cache would hide a settings edit (baseURL, displayName) for its whole TTL.
  const config = providerConfigOf(ctx, providerId)
  const displayName = config.displayName ?? providerId
  const base = { provider: providerId, displayName, fetchedAt: Date.now(), refreshMs }
  const probe = resolveProbe(providerId, config.baseURL)
  if (probe === undefined) {
    return {
      ...base,
      status: 'unsupported',
      message: 'no balance or quota endpoint is known for this provider',
    }
  }
  const envNames = probe.envNames ?? []
  try {
    const local = probe.local
    let requests: readonly LocalRequest[]
    if (local === undefined) {
      const key = await apiKeyOf(ctx, config, envNames)
      if (key === undefined) {
        return {
          ...base,
          status: 'error',
          message: `no credential is configured for this route (${config.apiKeyEnv ?? envNames.join(' / ')})`,
        }
      }
      if (probe.requests !== undefined) {
        // The endpoint names ids only the provider knows: read its listing
        // first, then ask each one it offers.
        requests = await probe.requests({ key, timeoutMs })
      } else if (probe.url === undefined) {
        return { ...base, status: 'error', message: 'this probe declares neither an endpoint nor a listing' }
      } else {
        requests = [{ url: probe.url, headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }]
      }
      if (requests.length === 0) {
        return {
          ...base,
          status: 'error',
          message: `${config.baseURL ?? providerId} listed no endpoint to ask`,
        }
      }
    } else {
      requests = await localRequests(local, {})
      if (requests.length === 0) {
        return {
          ...base,
          status: 'error',
          message: `no usable ${local} CLI credential is on this machine`,
        }
      }
    }

    let outcome = await fetchAll(requests, timeoutMs)
    // A live-looking token can still be refused: rotate once and retry, which is
    // what the CLI's own fetcher does. Cursor has no refresh path, so a retry
    // there would only repeat the same refused request.
    if (local !== undefined && local !== 'cursor' && !outcome.ok && outcome.refused) {
      const retried = await localRequests(local, { forceRefresh: true })
      if (retried.length > 0) outcome = await fetchAll(retried, timeoutMs)
    }
    if (!outcome.ok) {
      return {
        ...base,
        status: 'error',
        message: `${requests[0]?.url ?? providerId} answered HTTP ${String(outcome.status)}`,
      }
    }
    const reading = probe.parse(outcome.payloads)
    if (reading === null) {
      return { ...base, status: 'error', message: 'the provider response carried no balance or quota figure' }
    }
    return {
      ...base,
      status: 'ok',
      kind: probe.kind,
      text: reading.text,
      ...reading.remaining === undefined ? {} : { remaining: reading.remaining },
      lines: reading.lines,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, status: 'error', message }
  }
}

/** What one round of provider requests produced. */
interface RoundOutcome {
  /** Whether at least one request answered with a body. */
  readonly ok: boolean
  /** The last status seen, for the failure message. */
  readonly status: number
  /** Whether a request was refused as unauthenticated or forbidden. */
  readonly refused: boolean
  /** Decoded bodies, aligned with the requests (absent entries are failures). */
  readonly payloads: readonly (unknown | undefined)[]
}

/**
 * Run every request of one probe in order, tolerating a partial answer: Grok
 * reports two meters and one of them may be unavailable, so only a round where
 * nothing answered is a failure.
 * @param requests - requests built from the provider's credential.
 * @param timeoutMs - per-request deadline.
 * @returns the decoded bodies, the last status, and the refusal flag.
 */
async function fetchAll(requests: readonly LocalRequest[], timeoutMs: number): Promise<RoundOutcome> {
  const payloads: (unknown | undefined)[] = []
  let status = 0
  let refused = false
  for (const request of requests) {
    try {
      const response = await fetch(request.url, {
        headers: request.headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      if (response.status === 401 || response.status === 403) refused = true
      payloads.push(response.ok ? await response.json().catch(() => undefined) : undefined)
    } catch {
      payloads.push(undefined)
    }
  }
  return { ok: payloads.some(payload => payload !== undefined), status, refused, payloads }
}

/**
 * Mount the host half.
 * @param ctx - host context carrying the route carrier.
 * @param config - this plugin's row configuration.
 */
export function apply(ctx: HostContext, row: Config | Options = {}): void {
  // Read the row at every use: each field is volatile, so a save from the
  // Plugins card has to reach the next reading rather than a mount-time copy.
  const live = (): Required<Options> => resolveRow(row)
  live()
  const cache = new Map<string, { at: number; body: string }>()
  const inflight = new Map<string, Promise<string>>()

  /**
   * Keep the report map at its cap: once it holds `MAX_REPORTS`, the oldest key
   * goes before the next insert. `Map` iterates in insertion order, so the first
   * key is the one inserted longest ago; an entry whose lifetime has passed is
   * already a miss on read, so it needs no sweep here.
   */
  const pruneReports = (): void => {
    if (cache.size < MAX_REPORTS) return
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  /**
   * Serve one provider's serialized reading: the cached body, or a fresh one.
   *
   * The body is serialized once, when the reading is taken, so a hit answers
   * with the bytes written then instead of serializing the same report again on
   * every poll.
   */
  const reportFor = (providerId: string, refresh: boolean): Promise<string> => {
    const { cacheSeconds, timeoutMs, refreshSeconds } = live()
    const hit = cache.get(providerId)
    if (!refresh && hit !== undefined && Date.now() - hit.at < cacheSeconds * 1_000) {
      return Promise.resolve(hit.body)
    }
    const running = inflight.get(providerId)
    if (running !== undefined) return running
    const pending = buildReport(ctx, providerId, timeoutMs, refreshSeconds * 1_000).then((report) => {
      pruneReports()
      const body = JSON.stringify(report)
      cache.set(providerId, { at: Date.now(), body })
      return body
    }).finally(() => {
      inflight.delete(providerId)
    })
    inflight.set(providerId, pending)
    return pending
  }

  const handler = async (req: RequestLike, res: ResponseLike): Promise<void> => {
    const rejection = connectionOf(ctx)?.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.setHeader('allow', 'GET')
      sendJson(res, 405, { status: 'error', message: 'this route answers GET only' })
      return
    }
    const params = searchParamsOf(String(req.url ?? ROUTE))
    const providerId = params.get('provider') ?? ''
    if (providerId.length === 0) {
      sendJson(res, 400, { status: 'error', message: 'a provider query parameter is required' })
      return
    }
    const body = await reportFor(providerId, params.get('refresh') === '1')
    sendBody(res, 200, body)
  }

  ctx.effect(
    (): Disposable => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }),
    `quota-check: GET ${ROUTE}`,
  )

  // A settings write moves the live references in place. Dropping the served
  // readings makes the next poll show the effect of the edit instead of a body
  // cached under the previous window, and the log line records what it became.
  ctx.on('loader/volatile-update', () => {
    cache.clear()
    const { cacheSeconds, timeoutMs, refreshSeconds } = live()
    ctx.logger.warn(
      `quota-check: configuration updated — ${cacheSeconds}s cache, ${timeoutMs}ms deadline,`
        + ` ${refreshSeconds}s browser refresh`,
    )
  })
}
