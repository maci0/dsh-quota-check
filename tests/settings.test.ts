/**
 * Settings contract: the loader-facing schema, the plain row resolver, and the
 * promise that an edit from the Plugins card reaches the next reading.
 *
 * @module dsh-quota-check/tests/settings
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Config,
  DEFAULT_CACHE_SECONDS,
  DEFAULT_REFRESH_SECONDS,
  DEFAULT_TIMEOUT_MS,
  resolveRow,
} from '../src/index.ts'
import { mount, request, stubFetch } from './harness.ts'

/** One live reference, exactly the `.get()` seam the loader supplies. */
function ref<T>(read: () => T): { get(): T } {
  return { get: read }
}

/** One provider payload the probes understand as a balance reading. */
const REPORT_PAYLOAD = {
  data: { balance: 12.5, currency: 'USD', label: 'credit' },
}

/** Services a balance reading needs: the route's own provider row. */
function services(): Parameters<typeof mount>[0] {
  return {
    settings: {
      describe: () => [{
        ns: 'llm-omniroute',
        value: { baseURL: 'https://omniroute.test/v1', apiKeyEnv: 'OMNIROUTE_API_KEY' },
      }],
    },
    credentials: { resolve: async () => ({ value: 'secret-key' }) },
  }
}

test('every field is volatile, and the plain resolver agrees with the schema', () => {
  const parsed = Config({}) as unknown as Record<string, { get(): number }>
  for (const key of ['cacheSeconds', 'timeoutMs', 'refreshSeconds'] as const) {
    assert.equal(typeof parsed[key]?.get, 'function', `${key} must be volatile`)
  }
  assert.deepEqual({ ...resolveRow({}) }, {
    cacheSeconds: DEFAULT_CACHE_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
  })
  // A deployment that states one field keeps the others at their defaults.
  assert.deepEqual({ ...resolveRow({ cacheSeconds: 5 }) }, {
    cacheSeconds: 5,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
  })
})

test('resolveRow reads references, so a caller can pass a live row', () => {
  const state = { cacheSeconds: 10 }
  const row = {
    cacheSeconds: ref(() => state.cacheSeconds),
    timeoutMs: ref(() => 5000),
    refreshSeconds: ref(() => 120),
  }
  assert.deepEqual({ ...resolveRow(row) }, { cacheSeconds: 10, timeoutMs: 5000, refreshSeconds: 120 })
  state.cacheSeconds = 0
  assert.equal(resolveRow(row).cacheSeconds, 0)
})

test('a live cache window edit takes effect on the next request', async () => {
  const state = { cacheSeconds: 3600, timeoutMs: 10_000, refreshSeconds: 300 }
  const { route, emitVolatile } = mount(services(), {
    cacheSeconds: ref(() => state.cacheSeconds),
    timeoutMs: ref(() => state.timeoutMs),
    refreshSeconds: ref(() => state.refreshSeconds),
  })
  const fetchStub = stubFetch(REPORT_PAYLOAD)

  try {
    const first = await request(route, '/quota-check?provider=omniroute')
    assert.equal(first.status, 200)
    assert.equal(fetchStub.calls.length, 1)

    // The hour-long window is still open: the second read is served from cache.
    const cached = await request(route, '/quota-check?provider=omniroute')
    assert.equal(cached.status, 200)
    assert.equal(fetchStub.calls.length, 1)

    // A save moves the reference in place and the loader emits this event.
    state.cacheSeconds = 0
    emitVolatile()

    const reread = await request(route, '/quota-check?provider=omniroute')
    assert.equal(reread.status, 200)
    assert.equal(fetchStub.calls.length, 2, 'the edit must drop the served reading')
  } finally {
    fetchStub.restore()
  }
})

test('a live refresh-cadence edit reaches the browser half', async () => {
  const state = { cacheSeconds: 60, timeoutMs: 10_000, refreshSeconds: 300 }
  const { route } = mount(services(), {
    cacheSeconds: ref(() => state.cacheSeconds),
    timeoutMs: ref(() => state.timeoutMs),
    refreshSeconds: ref(() => state.refreshSeconds),
  })
  const fetchStub = stubFetch(REPORT_PAYLOAD)

  try {
    const first = await request(route, '/quota-check?provider=omniroute')
    assert.equal((first.body as { refreshMs: number }).refreshMs, 300_000)

    state.refreshSeconds = 45
    const second = await request(route, '/quota-check?provider=omniroute&refresh=1')
    assert.equal((second.body as { refreshMs: number }).refreshMs, 45_000)
  } finally {
    fetchStub.restore()
  }
})

test('a row outside the schema bounds still fails the write, not the read', () => {
  assert.throws(() => Config({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => resolveRow({ cacheSeconds: -1 }), /cacheSeconds/)
})

test('a read in flight during a settings write is neither handed out, cached, nor allowed to evict its successor', async () => {
  const state = { refreshSeconds: 300 }
  const { route, emitVolatile } = mount({
    llm: {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
    },
    settings: { describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'TEST_KEY' } }] },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
  }, {
    cacheSeconds: ref(() => 3600),
    timeoutMs: ref(() => 10_000),
    refreshSeconds: ref(() => state.refreshSeconds),
  })
  const original = globalThis.fetch
  // Every answer waits for its own release, so two reads can be in flight at
  // once and a third poll has something to coalesce onto.
  const held: (() => void)[] = []
  globalThis.fetch = (() => new Promise((resolve) => {
    held.push(() => {
      resolve(new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '1' }] }), { status: 200 }))
    })
  })) as typeof globalThis.fetch
  const url = '/quota-check?provider=deepseek-official'
  const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  try {
    const first = request(route, url)
    await settle()
    assert.equal(held.length, 1, 'the first read is in flight')

    state.refreshSeconds = 45
    emitVolatile()

    // A poll after the write must not be handed the read the old row started.
    const second = request(route, url)
    await settle()
    assert.equal(held.length, 2, 'the post-write poll started its own read')

    // The orphaned read settles: it answers its caller, but neither caches its
    // old-row body nor retracts the live read from the in-flight map.
    held[0]?.()
    assert.equal(((await first).body as { refreshMs: number }).refreshMs, 300_000)
    const third = request(route, url)
    await settle()
    assert.equal(held.length, 2, 'a poll between reads joins the live read')

    held[1]?.()
    assert.equal(((await second).body as { refreshMs: number }).refreshMs, 45_000)
    assert.equal(((await third).body as { refreshMs: number }).refreshMs, 45_000)
    const cached = await request(route, url)
    assert.equal((cached.body as { refreshMs: number }).refreshMs, 45_000, 'the cache holds the new row')
    assert.equal(held.length, 2)
  } finally {
    globalThis.fetch = original
  }
})
