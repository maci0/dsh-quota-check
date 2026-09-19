/**
 * Narrowing helpers shared by the probes, the local-usage reader, and the
 * route: every provider answer is an unknown until one of these reads it.
 *
 * @module util
 */
/** Narrow an unknown to an indexable object. */
export declare function record(value: unknown): Record<string, unknown> | undefined;
/** Read one field as a non-empty string, or `undefined`. */
export declare function stringOf(value: unknown): string | undefined;
/** Read one field as a finite number, or `undefined`. */
export declare function numberOf(value: unknown): number | undefined;
/** Parse an ISO timestamp as epoch milliseconds, or `undefined`. */
export declare function isoToMs(value: unknown): number | undefined;
