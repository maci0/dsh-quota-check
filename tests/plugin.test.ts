/**
 * Host half: the route the browser half reads, driven through the same public
 * `apply` a composition calls. The fake context carries the injected services
 * plus only the optional ones a case mounts, so these cases fail if the plugin
 * starts needing a service it does not inject.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE } from '../src/index.ts'
import { mount, request, stubFetch, type Services } from './harness.ts'

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

test('a route whose host is not a LiteLLM proxy renders no chip, not a failure', async () => {
  // The LiteLLM key-budget endpoint is a guess about a host the route never
  // named: a 404 there means "this host is not a LiteLLM", which is absent
  // data, not a failed reading. A local vLLM route must stay silent (README
  // "local inference (vLLM) ... renders nothing"), not grow a `quota ?` chip.
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'vllm-local', displayName: 'vLLM', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'vllm-local'] }] },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: { providers: { 'vllm-local': { apiKeyEnv: 'VLLM_API_KEY', baseURL: 'http://192.168.0.211:8000/v1' } } },
      }],
    },
    credentials: { resolve: async () => ({ value: 'sk-local' }) },
  })
  const stub = stubFetch({}, { status: 404 })
  try {
    const reply = await request(route, `${ROUTE}?provider=vllm-local`)
    assert.equal(stub.calls.length, 1, 'the guessed endpoint is still asked once')
    assert.equal(reply.status, 200)
    assert.equal((reply.body as { status: string }).status, 'unsupported')
  } finally {
    stub.restore()
  }
})

test('an unconfigured credential on an unrecognized host renders no chip either', async () => {
  // No credential at all is the other shape of the same guess: nothing on this
  // route says LiteLLM, so there is nothing to report rather than a failure.
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'vllm-local', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'vllm-local'] }] },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'vllm-local': { baseURL: 'http://192.168.0.211:8000/v1' } } } }],
    },
  })
  const stub = stubFetch({})
  try {
    const reply = await request(route, `${ROUTE}?provider=vllm-local`)
    assert.equal(stub.calls.length, 0)
    assert.equal(reply.status, 200)
    assert.equal((reply.body as { status: string }).status, 'unsupported')
  } finally {
    stub.restore()
  }
})

test('a settings directory that throws is reported, not thrown out of the route', async () => {
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }] },
    settings: { describe: () => { throw new Error('settings backend offline') } },
  })
  const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
  assert.equal(reply.status, 200)
  assert.equal((reply.body as { status: string }).status, 'error')
  // The cause goes to the host log; the report carries this plugin's sentence.
  assert.equal((reply.body as { message: string }).message, 'the reading failed; the host log names the cause')
})

test('a route that names LiteLLM still reports its missing endpoint as a failure', async () => {
  // The tentative rule must not swallow a genuine failure on a route that does
  // name LiteLLM: a 404 there is a broken deployment, not absent data.
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'litellm', settingsNs: 'llm-litellm', settingsPath: [] }] },
    settings: { describe: () => [{ ns: 'llm-litellm', value: { apiKeyEnv: 'LITELLM_API_KEY' } }] },
    credentials: { resolve: async () => ({ value: 'sk-proxy' }) },
  })
  const stub = stubFetch({}, { status: 404 })
  try {
    const reply = await request(route, `${ROUTE}?provider=litellm`)
    assert.equal((reply.body as { status: string }).status, 'error')
    assert.match(String((reply.body as { message: string }).message), /HTTP 404/)
  } finally {
    stub.restore()
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

test('a token endpoint that never answers cannot hold the reading past the deadline', async () => {
  // The Codex token is expired, so the reading first rotates it. The token
  // host hangs; the reading must give up on it at the configured deadline and
  // read with the token it has, instead of holding the route open forever.
  const home = await mkdtemp(join(tmpdir(), 'quota-check-test-'))
  const savedHome = process.env['HOME']
  const original = globalThis.fetch
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const expired = `${encode({ alg: 'RS256' })}.${encode({ exp: Math.floor(Date.now() / 1_000) - 60 })}.signature`
  try {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({
      tokens: { access_token: expired, refresh_token: 'refresh', account_id: 'acct' },
    }))
    process.env['HOME'] = home
    globalThis.fetch = ((url: string | URL, init?: { signal?: AbortSignal }) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
      }), { status: 200 }))
    }) as typeof globalThis.fetch
    const { route } = mount({}, { timeoutMs: 50 })
    let guard: NodeJS.Timeout | undefined
    const hung = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => { reject(new Error('the route hung on the token endpoint')) }, 2_000)
    })
    try {
      const reply = await Promise.race([request(route, `${ROUTE}?provider=codex`), hung])
      assert.equal((reply.body as { status: string }).status, 'ok')
      assert.equal((reply.body as { text: string }).text, 'Codex 90%')
    } finally {
      clearTimeout(guard)
    }
  } finally {
    globalThis.fetch = original
    if (savedHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = savedHome
    await rm(home, { recursive: true, force: true })
  }
})

test('an omniroute connection id of . or .. is never asked', async () => {
  // Both survive `encodeURIComponent`, and the URL parser then climbs out of
  // `/api/usage/` into another router endpoint with the bearer attached.
  const { route } = mount({
    llm: { listConfigurableProviders: () => [{ provider: 'omniroute', displayName: 'OmniRoute', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'omniroute'] }] },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { omniroute: { baseURL: 'http://192.168.0.100:20128/v1' } } } }] },
    credentials: { resolve: async () => ({ value: 'or-test' }) },
  })
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const target = String(url)
    calls.push(target)
    const body = target.endsWith('/api/providers')
      ? { connections: [{ id: '.' }, { id: '..' }, { id: 'acbe', provider: 'deepseek' }] }
      : { plan: 'DeepSeek', quotas: { credits_usd: { remaining: 91.43, currency: 'USD', unlimited: true } } }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  try {
    await request(route, `${ROUTE}?provider=omniroute`)
    assert.deepEqual(calls, [
      'http://192.168.0.100:20128/api/providers',
      'http://192.168.0.100:20128/api/usage/acbe',
    ])
  } finally {
    globalThis.fetch = original
  }
})

test('a failure outside this plugin is reported without its raw text', async () => {
  // A credential store may phrase a failure with host paths or internals; the
  // report (and the chip tooltip) carries this plugin's own sentence instead.
  const { route } = mount({
    ...deepSeekServices(),
    credentials: { resolve: async () => { throw new Error('keyring /home/u/.vault locked') } },
  })
  const stub = stubFetch({})
  try {
    const reply = await request(route, `${ROUTE}?provider=deepseek-official`)
    const body = reply.body as { status: string; message: string }
    assert.equal(body.status, 'error')
    assert.doesNotMatch(body.message, /keyring|vault/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a base URL without an http(s) scheme is a configuration error, and nothing is sent', async () => {
  // `api.deepseek.com` or `box:20128` has no scheme: guessing an origin would
  // send the key somewhere nobody configured, and `new URL` gives "null".
  for (const [provider, baseURL] of [['deepseek-official', 'api.deepseek.com'], ['omniroute', 'box:20128'], ['claude', 'ftp://anthropic']] as const) {
    const resolved: string[] = []
    const { route } = mount({
      llm: { listConfigurableProviders: () => [{ provider, settingsNs: 'llm-x', settingsPath: [] }] },
      settings: { describe: () => [{ ns: 'llm-x', value: { apiKeyEnv: 'TEST_KEY', baseURL } }] },
      credentials: { resolve: async (ref: string) => { resolved.push(ref); return { value: 'sk-test' } } },
    })
    const stub = stubFetch({})
    try {
      const reply = await request(route, `${ROUTE}?provider=${provider}`)
      const body = reply.body as { status: string; message: string }
      assert.equal(body.status, 'error', provider)
      assert.match(body.message, /baseURL is not an absolute http\(s\) URL/, provider)
      assert.equal(stub.calls.length, 0, `${provider}: no request`)
      assert.deepEqual(resolved, [], `${provider}: no credential resolved`)
    } finally {
      stub.restore()
    }
  }
})
