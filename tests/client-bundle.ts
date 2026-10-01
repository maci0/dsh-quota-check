/**
 * The browser bundle, imported once per test process: `lib/client.js` hands
 * its registration to `window.__ModuleLoader__` as the module system receives
 * it in the page, and the specs call the captured factory per case, which
 * builds fresh state. A module is evaluated once per process, so every spec
 * shares this capture instead of importing the bundle itself.
 *
 * @module dsh-quota-check/tests/client-bundle
 */

import assert from 'node:assert/strict'

/** What the bundle hands `window.__ModuleLoader__.load`. */
export interface Registration {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

let captured: Registration | undefined
const scope = globalThis as { window?: unknown }
const previous = scope.window
scope.window = { __ModuleLoader__: { load: (spec: Registration): void => { captured = spec } } }
try {
  await import(new URL('../lib/client.js', import.meta.url).href)
} finally {
  scope.window = previous
}
assert.ok(captured, 'lib/client.js registered itself on window.__ModuleLoader__')

/** The registration `lib/client.js` made when imported. */
export const REGISTRATION: Registration = captured
