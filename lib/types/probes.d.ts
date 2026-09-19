/**
 * Provider quota/balance probes: which endpoint answers for a provider route,
 * and how its payload becomes one statusbar line plus tooltip detail.
 *
 * A probe resolves from a provider id and an optional configured base URL, and
 * a parser turns a decoded JSON payload into a {@link ProbeReading}. Host-only
 * concerns — credentials, HTTP, caching — live in `index.ts`, which is what
 * makes these rules testable without a network. One exception: an endpoint whose
 * ids the configuration cannot name (OmniRoute asks per upstream connection)
 * declares `requests`, which reads the listing before the host asks each id.
 *
 * Four endpoints report a *server-side* figure: DeepSeek's `/user/balance`,
 * OpenRouter's `/credits`, the z.ai / BigModel Coding Plan quota, and LiteLLM's
 * `/key/info` (spend and remaining budget for the calling key). LiteLLM is also
 * the fallback for any otherwise-unknown route with a configured base URL,
 * because a proxy deployment names its routes after the models it serves, not
 * after the proxy — an unknown host that answers `/key/info` is a LiteLLM. A
 * route whose host publishes neither resolves no probe and the statusbar stays
 * empty.
 *
 * @module dsh-quota-check/probes
 */
import type { LocalProvider, LocalRequest } from './local-usage.ts';
/** Short reading for one provider: the chip text and its tooltip lines. */
export interface ProbeReading {
    /** Compact statusbar text, e.g. `¥110.00` or `GLM 58%`. */
    readonly text: string;
    /** Tooltip detail lines, in display order. */
    readonly lines: readonly string[];
    /** Remaining quota as a percentage, when the reading is a metered quota. */
    readonly remaining?: number;
}
/** What one provider reports: a spendable balance, or a plan quota. */
export type ProbeKind = 'balance' | 'quota';
/**
 * The bodies a probe asked for, aligned with its requests: `undefined` marks a
 * request that failed, so a two-meter provider (Grok's weekly and monthly
 * calls) still reports when only one of them answered.
 */
export type ProbePayloads = readonly (unknown | undefined)[];
/** What a probe that discovers its own endpoints is handed. */
export interface ProbeExpandContext {
    /** The route's resolved credential. */
    readonly key: string;
    /** Per-request deadline in milliseconds, for the listing request itself. */
    readonly timeoutMs: number;
}
/**
 * Build a probe's requests from an earlier answer, for endpoints whose ids the
 * route's configuration cannot name.
 * @param context - the credential and deadline to list with.
 * @returns the requests to ask, in the order their payloads arrive.
 */
export type ProbeExpander = (context: ProbeExpandContext) => Promise<readonly LocalRequest[]>;
/** Everything a probe shares, whatever its credential source. */
interface ProbeBase {
    /** Which kind of figure this is. */
    readonly kind: ProbeKind;
    /** Credential references tried when the provider configuration names none. */
    readonly envNames: readonly string[];
    /**
     * Requests discovered from an earlier answer, for a route whose endpoint
     * names an id only the provider itself knows.
     */
    readonly requests?: ProbeExpander;
    /**
     * Turn the decoded payloads into a reading.
     * @param payloads - decoded JSON bodies, in request order.
     * @returns the reading, or `null` when none carries a usable figure.
     */
    parse(payloads: ProbePayloads): ProbeReading | null;
}
/**
 * One probe: the endpoint it reads, and the credential that endpoint expects.
 * A key probe fetches one URL with a bearer token resolved from settings; a
 * local probe reads the subscription credential a CLI left on this machine and
 * may ask two endpoints of the same account.
 */
export type Probe = ProbeBase & ({
    /**
     * Absolute URL to GET with the provider's bearer credential. Absent when
     * the probe discovers its own requests instead.
     */
    readonly url?: string;
    readonly local?: undefined;
} | {
    /** Local CLI credential this endpoint reads instead of a settings key. */
    readonly local: LocalProvider;
    readonly url?: undefined;
});
/**
 * Format an amount for the statusbar.
 * @param amount - absolute amount.
 * @param currency - ISO currency code, when the provider reports one.
 * @returns symbol-prefixed amount with two decimals, or the amount with its code.
 */
export declare function formatMoney(amount: number, currency?: string): string;
/**
 * Resolve the probe answering for one provider route.
 *
 * A configured base URL decides alone when it names a known host, because the
 * host is the endpoint that actually answers. The provider id only decides
 * when no base URL is configured (the route relies on its library's own
 * default), so a route named after a provider but pointed somewhere else — a
 * local vLLM serving DeepSeek weights, or Vertex-hosted Claude, say — is never
 * read from that provider's own subscription credential.
 *
 * The subscription probes come first among the id-based rules because their
 * host is the vendor itself, not a reseller: a route called `anthropic` with no
 * base URL is Claude Code's plan meter, while `google-vertex-anthropic` carries
 * a googleapis.com host and resolves nothing.
 *
 * A route that names no vendor and still has a base URL gets the LiteLLM
 * key-budget probe, which is how a proxy deployment is recognized at all.
 * @param providerId - route id as the model picker names it, e.g. `deepseek-official`.
 * @param baseURL - the route's configured base URL, when it has one.
 * @returns the probe, or `undefined` when no balance or quota route is known.
 */
export declare function resolveProbe(providerId: string, baseURL?: string): Probe | undefined;
export {};
