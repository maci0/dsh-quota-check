/**
 * Host half: the route the browser half reads, driven through the same public
 * `apply` a composition calls. The fake context carries only the services this
 * plugin declares structurally, so these cases fail if the plugin starts
 * needing a service a bare composition does not mount.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, ROUTE } from '../src/index.ts'
import type { Disposable, HostContext, SettingsDescriptorLike, WebRouteLike } from '../src/host.ts'

/** One captured response. */
interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** Services a case may mount; absent keys read as "not mounted". */
interface Services {
  llm?: unknown
  settings?: { describe(): readonly SettingsDescriptorLike[] }
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  connection?: { requestRejection(request: { headers: object | undefined }): 401 | 403 | undefined }
}

/** Mount the plugin over a fake context and return its registered route. */
function mount(services: Services, config?: { cacheSeconds?: number }): { route: WebRouteLike; disposers: Disposable[] } {
  const routes: WebRouteLike[] = []
  const disposers: Disposable[] = []
  const ctx = {
    inject: (): void => {},
    effect: (callback: () => Disposable | void): void => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get: (name: string): unknown => (services as Record<string, unknown>)[name],
    logger: { warn: (): void => {}, error: (): void => {} },
    webServer: {
      register: (route: WebRouteLike): Disposable => {
        routes.push(route)
        return () => {}
      },
    },
  } as unknown as HostContext
  apply(ctx, config)
  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.ok(route)
  assert.equal(route.path, ROUTE)
  return { route, disposers }
}

/** Run one request through the route. */
async function request(route: WebRouteLike, url: string, method = 'GET', headers: object = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string): void { captured.headers[name] = value },
    end(body?: string): void {
      captured.status = res.statusCode
      captured.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
  await route.handler({ method, url, headers }, res)
  return captured
}

/** Replace global fetch for one case; returns the calls it saw and a restore. */
function stubFetch(payload: unknown, options?: { status?: number }): { calls: { url: string; headers: Record<string, string> }[]; restore: () => void } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return Promise.resolve({
      ok: (options?.status ?? 200) < 400,
      status: options?.status ?? 200,
      json: () => Promise.resolve(payload),
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Services pointing at the DeepSeek balance endpoint. */
function deepSeekServices(): Services {
  return {
    llm: {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
    },
    settings: {
      describe: () => [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'TEST_DEEPSEEK_KEY', baseURL: 'https://api.deepseek.com' } },
      ],
    },
    credentials: { resolve: async (ref: string) => (ref === 'TEST_DEEPSEEK_KEY' ? { value: 'sk-test' } : undefined) },
  }
}

test('the route answers the provider balance in the configured credential scope', async () => {
  const { route } = mount(deepSeekServices())
  const stub = stubFetch({ balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] })
  try {
    const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body, {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      status: 'ok',
      kind: 'balance',
      text: '¥110.00',
      lines: ['Balance ¥110.00'],
      fetchedAt: (reply.body as { fetchedAt: number }).fetchedAt,
      refreshMs: 300_000,
    })
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]?.url, 'https://api.deepseek.com/user/balance')
    assert.equal(stub.calls[0]?.headers['authorization'], 'Bearer sk-test')
  } finally {
    stub.restore()
  }
})

test('a reading is cached, so a rerender never re-asks the provider', async () => {
  const { route } = mount({ ...deepSeekServices(), credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  const stub = stubFetch({ balance_infos: [{ currency: 'USD', total_balance: '4' }] })
  try {
    await request(route, `${ROUTE}?provider=deepseek-official`)
    await request(route, `${ROUTE}?provider=deepseek-official`)
    assert.equal(stub.calls.length, 1)
    await request(route, `${ROUTE}?provider=deepseek-official&refresh=1`)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('a provider with no published balance route reports unsupported and asks nobody', async () => {
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'mystery-route', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mystery-route'] }] },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'mystery-route': {} } } }] },
  })
  const stub = stubFetch({})
  try {
    const reply = await request(route, `${ROUTE}?provider=mystery-route`)
    assert.equal((reply.body as { status: string }).status, 'unsupported')
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('an omniroute route reads its connection listing, then each connection quota', async () => {
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'omniroute', displayName: 'OmniRoute', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'omniroute'] }] },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { omniroute: { apiKeyEnv: 'OMNIROUTE_API_KEY', baseURL: 'http://192.168.0.100:20128/v1' } } } }] },
    credentials: { resolve: async () => ({ value: 'or-test' }) },
  })
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const target = String(url)
    calls.push(target)
    const body = target.endsWith('/api/providers')
      ? { connections: [{ id: 'acbe', name: 'main', provider: 'deepseek', quotaVisible: true, isActive: true }] }
      : {
        plan: 'DeepSeek',
        quotas: { credits_usd: { used: 0, total: 0, remaining: 91.43, currency: 'USD', unlimited: true, resetAt: null } },
        limitReached: false,
      }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  try {
    const reply = await request(route, `${ROUTE}?provider=omniroute`)
    assert.deepEqual(calls, [
      'http://192.168.0.100:20128/api/providers',
      'http://192.168.0.100:20128/api/usage/acbe',
    ])
    assert.equal((reply.body as { status: string }).status, 'ok')
    assert.equal((reply.body as { text: string }).text, '$91.43')
  } finally {
    globalThis.fetch = original
  }
})

test('a missing credential is an error report, not a provider call', async () => {
  const { route } = mount({ ...deepSeekServices(), credentials: { resolve: async () => undefined } })
  const stub = stubFetch({})
  try {
    const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
    assert.equal((reply.body as { status: string }).status, 'error')
    assert.match(String((reply.body as { message: string }).message), /TEST_DEEPSEEK_KEY/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a provider HTTP failure is reported without its body', async () => {
  const { route } = mount({ ...deepSeekServices(), credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  const stub = stubFetch({ secret: 'leak' }, { status: 401 })
  try {
    const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
    assert.equal((reply.body as { status: string }).status, 'error')
    assert.match(String((reply.body as { message: string }).message), /HTTP 401/)
    assert.doesNotMatch(JSON.stringify(reply.body), /leak/)
  } finally {
    stub.restore()
  }
})

test('the route refuses a missing provider and a bad method', async () => {
  const { route } = mount(deepSeekServices())
  assert.equal((await request(route, ROUTE)).status, 400)
  assert.equal((await request(route, `${ROUTE}?provider=deepseek-official`, 'POST')).status, 405)
})

test('an untrusted caller is fenced off before any lookup', async () => {
  const { route } = mount({
    ...deepSeekServices(),
    connection: { requestRejection: () => 401 },
  })
  const stub = stubFetch({})
  try {
    const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
    assert.equal(reply.status, 401)
    assert.equal(reply.body, undefined)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})
