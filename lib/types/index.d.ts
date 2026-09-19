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
import type { HostContext } from './host.ts';
/** Plugin name as it appears in the loader. */
export declare const name = "quota-check";
/** The route carrier is the one service this plugin cannot work without. */
export declare const inject: string[];
/** The route the browser half reads. */
export declare const ROUTE = "/quota-check";
/** Seconds one provider's reading is served without re-asking the provider. */
export declare const DEFAULT_CACHE_SECONDS = 60;
/** Per-request ceiling for a provider call, in milliseconds. */
export declare const DEFAULT_TIMEOUT_MS = 10000;
/** Seconds the browser half waits between re-reads, unless configured otherwise. */
export declare const DEFAULT_REFRESH_SECONDS = 300;
/** Configuration accepted from this plugin's row in a profile patch. */
export interface Config {
    /** Seconds a reading stays cached. `0` re-asks on every request. @default 60 */
    readonly cacheSeconds?: number;
    /** Per-request provider deadline in milliseconds. @default 10000 */
    readonly timeoutMs?: number;
    /** Seconds between the browser half's re-reads. @default 300 */
    readonly refreshSeconds?: number;
}
/**
 * Row schema: what Cordis validates this plugin's `config` against, and where
 * each default lives. Every value here is a deployment choice — the cadences
 * and the deadline vary by machine — so none is a constant only this plugin
 * could change.
 */
export declare const Config: Schema<Config>;
/** One provider's answer, as the browser half reads it. */
export interface QuotaReport {
    /** Route id the report belongs to. */
    readonly provider: string;
    /** Display name for the route, when the registry declares one. */
    readonly displayName: string;
    /** `ok` renders the figure; `unsupported` and `error` render nothing. */
    readonly status: 'ok' | 'unsupported' | 'error';
    /** Which kind of figure this is, on `ok`. */
    readonly kind?: 'balance' | 'quota';
    /** Compact statusbar text, on `ok`. */
    readonly text?: string;
    /** Tooltip detail lines, on `ok`. */
    readonly lines?: readonly string[];
    /** Remaining quota as a percentage, on `ok` when the reading is metered. */
    readonly remaining?: number;
    /** Why there is no figure, on `unsupported` and `error`. */
    readonly message?: string;
    /** When the reading was taken, epoch milliseconds. */
    readonly fetchedAt: number;
    /** How long the browser half should wait before re-reading, in milliseconds. */
    readonly refreshMs: number;
}
/**
 * Mount the host half.
 * @param ctx - host context carrying the route carrier.
 * @param config - this plugin's row configuration.
 */
export declare function apply(ctx: HostContext, config?: Config): void;
