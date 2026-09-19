/**
 * Local CLI credentials for the subscription providers: where the token lives,
 * when it is stale, how it rotates, and the exact headers the vendor's usage
 * endpoint expects.
 *
 * These four providers bill a plan, not a key, so there is no settings API key
 * to resolve: the token already sits on this machine, written by the CLI the
 * human signed into. This module is the port of `quota-widget`'s fetchers
 * (`~/Desktop/Projects/quota-widget/package/contents/code/fetch_quota.py`);
 * it keeps the observable behavior — file paths, expiry skews, refresh bodies,
 * and the write-back that keeps the CLI itself signed in — and drops the parts
 * a statusbar chip does not need (disk caches, Retry-After sleeps, the TUI
 * JSON shape).
 *
 * Rotation writes back only through an atomic replace in the file's own
 * directory, mode 0600, preserving every other field, so a crash mid-write can
 * never leave a CLI with a truncated credential.
 *
 * @module dsh-quota-check/local-usage
 */
/** The subscription providers whose credentials live on this machine. */
export type LocalProvider = 'claude' | 'codex' | 'grok' | 'cursor';
/** One outbound request built from a local credential. */
export interface LocalRequest {
    /** Absolute URL to GET. */
    readonly url: string;
    /** Headers the vendor expects, including the credential itself. */
    readonly headers: Readonly<Record<string, string>>;
}
/** Options for reading a local credential. */
export interface LocalOptions {
    /** Home directory the CLI files hang off; defaults to the running user's. */
    readonly home?: string;
    /** Refresh even when the token looks unexpired; the 401 retry path uses this. */
    readonly forceRefresh?: boolean;
}
/**
 * Build the outbound requests for one subscription provider.
 * @param provider - which CLI credential to read.
 * @param options - home directory and forced-refresh flag.
 * @returns one or two requests, or `[]` when nothing usable is on disk.
 */
export declare function localRequests(provider: LocalProvider, options?: LocalOptions): Promise<readonly LocalRequest[]>;
