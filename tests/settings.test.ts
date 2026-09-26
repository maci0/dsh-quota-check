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
