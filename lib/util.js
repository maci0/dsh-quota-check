/**
 * Narrowing helpers shared by the probes, the local-usage reader, and the
 * route: every provider answer is an unknown until one of these reads it.
 *
 * @module util
 */
/** Narrow an unknown to an indexable object. */
export function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** Read one field as a non-empty string, or `undefined`. */
export function stringOf(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** Read one field as a finite number, or `undefined`. */
export function numberOf(value) {
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}
/** Parse an ISO timestamp as epoch milliseconds, or `undefined`. */
export function isoToMs(value) {
    if (typeof value !== 'string' || value === '')
        return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
