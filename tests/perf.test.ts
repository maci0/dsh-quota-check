/**
 * Deterministic growth check for the host half's report cache.
 *
 * Wall clock is not asserted: it moves with turbo, neighbours, and the
 * container's CPU quota. This case counts work instead — provider fetches —
 * which is what the `MAX_REPORTS` cap exists to bound. A long-lived host that
 * is asked about one route id per model ever picked must not keep a report for
 * every id forever: past the cap the oldest entries go, so asking for one of
 * them again is a fresh read while a recent one is still served from cache.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROUTE } from '../src/index.ts'
import type { WebRouteLike } from '../src/host.ts'
import { mount, request, type Services } from './harness.ts'

/** Live report entries the host half keeps before it starts evicting. */
const MAX_REPORTS = 512

/** Counters one case reads after its requests have run. */
interface Counters {
  /** Provider requests the stub fetch answered. */
  fetch: number
}

/** The real fetch, restored after every case. */
const nativeFetch = globalThis.fetch

/** Services naming `providerIds` as the routes the registry declares. */
function services(providerIds: readonly string[]): Services {
  return {
    llm: {
      listConfigurableProviders: () => providerIds.map(id => ({ provider: id, displayName: id, settingsNs: 'llm-perf', settingsPath: [] })),
    },
    settings: { describe: () => [{ ns: 'llm-perf', value: {} }] },
    credentials: { resolve: async () => ({ value: 'sk-perf' }) },
  }
}

/** Count provider fetches for one case; returns the restore. */
function countFetch(counters: Counters): () => void {
  globalThis.fetch = (() => {
    counters.fetch += 1
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ balance_infos: [{ currency: 'USD', total_balance: '1.00' }] }),
    })
  }) as unknown as typeof globalThis.fetch
  return () => { globalThis.fetch = nativeFetch }
}

/** Ask the mounted route for one provider, with any extra query text appended. */
async function ask(route: WebRouteLike, provider: string, extra = ''): Promise<void> {
  await request(route, `${ROUTE}?provider=${encodeURIComponent(provider)}${extra}`)
}

/** Count `JSON.stringify` calls while a case runs. */
function countSerialize(): { count: () => number; restore: () => void } {
  const native = JSON.stringify
  let calls = 0
  JSON.stringify = ((...args: Parameters<typeof native>) => { calls += 1; return native(...args) }) as typeof native
  return { count: () => calls, restore: () => { JSON.stringify = native } }
}

/** Count full-`URL` constructions while a case runs. */
function countUrlConstructions(): { count: () => number; restore: () => void } {
  const native = globalThis.URL
  let built = 0
  globalThis.URL = class extends native {
    constructor(url: string | URL, base?: string | URL) {
      super(url, base)
      built += 1
    }
  } as unknown as typeof URL
  return { count: () => built, restore: () => { globalThis.URL = native } }
}

test('past the cap the oldest report is evicted and a recent one is still cached', async () => {
  const ids = Array.from({ length: MAX_REPORTS + 88 }, (_, index) => `deepseek-${index}`)
  const newest = ids[ids.length - 1]
  const oldest = ids[0]
  assert.ok(newest !== undefined && oldest !== undefined)
  const { route } = mount(services(ids), { cacheSeconds: 60 })
  const counters: Counters = { fetch: 0 }
  const restore = countFetch(counters)
  try {
    for (const id of ids) await ask(route, id)
    // Every id was a first sight, so every one read its provider once.
    assert.equal(counters.fetch, ids.length)

    // The newest id is still inside the cap: its reading is served from cache.
    await ask(route, newest)
    assert.equal(counters.fetch, ids.length)

    // The oldest id was evicted when the cap tripped: it reads the provider again.
    await ask(route, oldest)
    assert.equal(counters.fetch, ids.length + 1)
  } finally {
    restore()
  }
})

test('a cached reading is serialized once, not once per request', async () => {
  const { route } = mount(services(['deepseek']), { cacheSeconds: 60 })
  const counters: Counters = { fetch: 0 }
  const restore = countFetch(counters)
  const serialize = countSerialize()
  try {
    // The first request misses: it builds the report and serializes it once.
    await ask(route, 'deepseek')
    const afterMiss = serialize.count()
    assert.equal(counters.fetch, 1)

    for (let index = 0; index < 300; index += 1) await ask(route, 'deepseek')
    assert.equal(counters.fetch, 1, 'a cached reading must not ask the provider again')
    assert.ok(
      serialize.count() <= afterMiss + 2,
      `300 cache hits serialized the report ${String(serialize.count() - afterMiss)} more times`,
    )
  } finally {
    serialize.restore()
    restore()
  }
})

test('a cached reading builds no URL, and refresh=1 still re-reads', async () => {
  const { route } = mount(services(['deepseek']), { cacheSeconds: 60 })
  const counters: Counters = { fetch: 0 }
  const restore = countFetch(counters)
  try {
    await ask(route, 'deepseek')
    const urls = countUrlConstructions()
    try {
      for (let index = 0; index < 300; index += 1) await ask(route, 'deepseek')
      assert.equal(counters.fetch, 1, 'a cached reading must not ask the provider again')
      assert.ok(urls.count() <= 2, `300 cache hits built ${String(urls.count())} URLs`)

      // The query string is still read: refresh=1 bypasses the cache.
      await ask(route, 'deepseek', '&refresh=1')
      assert.equal(counters.fetch, 2, 'refresh=1 must re-read the provider')
    } finally {
      urls.restore()
    }
  } finally {
    restore()
  }
})
