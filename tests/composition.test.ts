/**
 * The real-composition entry test the repository testing policy asks for: the
 * plugin is mounted into a real Cordis `Context` beside the real HTTP carrier
 * (`@deepseek-ai/dsh-host-webserver`) on an OS-assigned port, and the route is
 * driven over real HTTP rather than through a captured handler object. Only the
 * provider call itself is stubbed — that is the expensive, nondeterministic
 * boundary the policy allows to be mocked — so routing, JSON encoding, the
 * trust fence's absence, and teardown run against the shipping implementation.
 *
 * The spec owns its port: the carrier is mounted on port 0 and disposed in the
 * test body, so nothing is left listening and no fixed port can collide with a
 * concurrently running spec.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as QuotaCheck from '../src/index.ts'

/** What one real HTTP call returned. */
interface HttpReply {
  status: number
  body: unknown
}

/** One HTTP GET against the composition's carrier. */
async function get(url: string): Promise<HttpReply> {
  const response = await fetch(url)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** Replace global fetch for the provider origin only, passing local calls through. */
function stubProviderFetch(payload: unknown): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith('http://127.0.0.1')) {
      calls.push(url)
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return original(input as string, init)
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('the plugin mounts, answers over real HTTP, and withdraws its route on dispose', async () => {
  const ctx = new Context()
  const carrier = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const stub = stubProviderFetch({ balance_infos: [{ currency: 'USD', total_balance: '12.5' }] })
  try {
    const server = ctx.get('webServer') as unknown as { port: number }
    assert.ok(server.port > 0, 'the carrier listens on an OS-assigned port')
    ctx.provide('llm', {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
    })
    ctx.provide('settings', {
      describe: () => [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'TEST_KEY', baseURL: 'https://api.deepseek.com' } },
      ],
    })
    ctx.provide('credentials', {
      resolve: async (ref: string) => (ref === 'TEST_KEY' ? { value: 'sk-test' } : undefined),
    })

    const plugin = await ctx.plugin(QuotaCheck as unknown as Parameters<typeof ctx.plugin>[0], {
      cacheSeconds: 0,
      refreshSeconds: 30,
    })
    const origin = `http://127.0.0.1:${String(server.port)}`
    const reply = await get(`${origin}/quota-check?provider=deepseek-official`)
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body, {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      status: 'ok',
      kind: 'balance',
      text: '$12.50',
      lines: ['Balance $12.50'],
      fetchedAt: (reply.body as { fetchedAt: number }).fetchedAt,
      refreshMs: 30_000,
    })
    assert.deepEqual(stub.calls, ['https://api.deepseek.com/user/balance'])

    // HMR safety: the registration is a `ctx.effect`, so unloading the fiber
    // removes the route from the real carrier.
    await plugin.dispose()
    assert.equal((await get(`${origin}/quota-check?provider=deepseek-official`)).status, 404)
  } finally {
    stub.restore()
    await carrier.dispose()
  }
})

test('the route refuses a provider it cannot answer for, over real HTTP', async () => {
  const ctx = new Context()
  const carrier = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  try {
    const server = ctx.get('webServer') as unknown as { port: number }
    await ctx.plugin(QuotaCheck as unknown as Parameters<typeof ctx.plugin>[0], {})
    const reply = await get(`http://127.0.0.1:${String(server.port)}/quota-check`)
    assert.equal(reply.status, 400)
    assert.equal((reply.body as { message: string }).message, 'a provider query parameter is required')
  } finally {
    await carrier.dispose()
  }
})

test('the exported Config carries every default and rejects a row outside its bounds', () => {
  // The Loader validates a bundle row against this schema, so the defaults and
  // the bounds are the configuration contract, not a comment about one.
  assert.deepEqual(QuotaCheck.Config({}), {
    cacheSeconds: QuotaCheck.DEFAULT_CACHE_SECONDS,
    timeoutMs: QuotaCheck.DEFAULT_TIMEOUT_MS,
    refreshSeconds: QuotaCheck.DEFAULT_REFRESH_SECONDS,
  })
  assert.throws(() => QuotaCheck.Config({ cacheSeconds: -1 }), /cacheSeconds/)
  assert.throws(() => QuotaCheck.Config({ refreshSeconds: 1 }), /refreshSeconds/)
})
