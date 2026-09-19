/**
 * Probe rules: endpoint resolution per provider route, and the payload shapes
 * of the three providers that publish a server-side balance or quota. These
 * cases run without a network or a harness: every input is a decoded payload
 * copied from the provider's own documented response.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMoney, resolveProbe } from '../src/probes.ts'

/**
 * Replace global fetch for one case, answering by pathname; a path this map
 * does not carry is a 404, which is how the provider behaves for an unknown
 * route.
 * @param calls - collects the URLs asked for, in order.
 * @param bodies - one body per pathname.
 * @returns the restore function.
 */
function stubFetch(calls: string[], bodies: Record<string, unknown>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const target = String(url)
    calls.push(target)
    const body = bodies[new URL(target).pathname]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: () => Promise.resolve(body ?? {}),
    })
  }) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

test('a deepseek route is probed at its balance endpoint', () => {
  const probe = resolveProbe('deepseek-official')
  assert.equal(probe?.kind, 'balance')
  assert.equal(probe?.url, 'https://api.deepseek.com/user/balance')
  assert.deepEqual(probe?.envNames, ['DEEPSEEK_API_KEY'])
})

test('a deepseek route honours its configured origin, not its path', () => {
  assert.equal(
    resolveProbe('deepseek-official', 'https://gateway.example.com/v1')?.url,
    undefined,
    'an unknown host is not assumed to speak the DeepSeek balance API',
  )
  assert.equal(
    resolveProbe('deepseek-official', 'https://api.deepseek.com/v1')?.url,
    'https://api.deepseek.com/user/balance',
  )
})

test('a route named after a provider but pointed elsewhere is never probed there', () => {
  assert.equal(resolveProbe('deepseek-local', 'http://192.168.0.211:8000/v1'), undefined)
  assert.equal(resolveProbe('zai-proxy', 'https://my-proxy.example.com/v1'), undefined)
})

test('openrouter resolves to its credits endpoint', () => {
  assert.equal(resolveProbe('openrouter', 'https://openrouter.ai/api/v1')?.url, 'https://openrouter.ai/api/v1/credits')
})

test('a route with no base URL and no known vendor resolves nothing', () => {
  assert.equal(resolveProbe('vllm-local'), undefined)
  assert.equal(resolveProbe('meta'), undefined)
  assert.equal(resolveProbe('opencode-go'), undefined)
})

test('an aggregator route falls back to the LiteLLM key-budget endpoint', () => {
  assert.equal(resolveProbe('my-proxy', 'http://192.168.0.100:20128/v1')?.url, 'http://192.168.0.100:20128/key/info')
  assert.equal(resolveProbe('my-litellm-proxy')?.url, 'http://localhost:4000/key/info')
  assert.equal(resolveProbe('litellm', 'https://llm.example.com/v1')?.url, 'https://llm.example.com/key/info')
})

test('an omniroute route reads OmniRoute own per-connection usage', () => {
  const probe = resolveProbe('omniroute', 'http://192.168.0.100:20128/v1')
  assert.equal(probe?.kind, 'quota')
  assert.equal(probe?.url, undefined, 'the endpoint ids come from the listing, not the configuration')
  assert.equal(typeof probe?.requests, 'function')
  assert.deepEqual(probe?.envNames, ['OMNIROUTE_API_KEY'])
  // The route id names the router, so the second box matches the same rule.
  assert.equal(typeof resolveProbe('omniroute-x570')?.requests, 'function')
})

test('the omniroute listing builds one usage request per visible, live connection', async () => {
  const probe = resolveProbe('omniroute', 'http://box.local:20128/v1')
  const calls: string[] = []
  const restore = stubFetch(calls, {
    '/api/providers': {
      connections: [
        { id: 'a', quotaVisible: true, isActive: true },
        { id: 'b', quotaVisible: false, isActive: true },
        { id: 'c', quotaVisible: true, isActive: false },
        { id: 'd' },
      ],
    },
  })
  try {
    const requests = await probe?.requests?.({ key: 'sk-test', timeoutMs: 1_000 }) ?? []
    assert.deepEqual(calls, ['http://box.local:20128/api/providers'])
    assert.deepEqual(requests.map(request => request.url), [
      'http://box.local:20128/api/usage/a',
      'http://box.local:20128/api/usage/d',
    ])
    assert.equal(requests[0]?.headers['authorization'], 'Bearer sk-test')
  } finally {
    restore()
  }
})

test('the omniroute listing that cannot be read yields no request at all', async () => {
  const probe = resolveProbe('omniroute', 'http://box.local:20128/v1')
  const restore = stubFetch([], {})
  try {
    assert.deepEqual(await probe?.requests?.({ key: 'sk-test', timeoutMs: 1_000 }), [])
  } finally {
    restore()
  }
})

test('omniroute reports the fullest upstream window, and a wallet as money', () => {
  const probe = resolveProbe('omniroute', 'http://box.local:20128/v1')
  const wallet = {
    plan: 'DeepSeek',
    quotas: {
      credits_usd: {
        used: 0,
        total: 0,
        remaining: 91.43,
        remainingPercentage: 100,
        unlimited: true,
        currency: 'USD',
        resetAt: null,
      },
    },
    limitReached: false,
  }
  const windows = {
    plan: 'plus',
    quotas: {
      session: { used: 0, total: 100, remaining: 100, remainingPercentage: 100, resetAt: null },
      weekly: { used: 32, total: 100, remaining: 68, remainingPercentage: 68, resetAt: '2026-09-24T06:46:49.000Z' },
    },
    limitReached: false,
  }
  assert.deepEqual(probe?.parse([wallet, windows]), {
    text: 'OmniRoute 68%', remaining: 68,
    lines: [
      'DeepSeek · Credits $91.43 left',
      'plus · Session 0% used',
      `plus · Weekly 32% used, resets ${new Date('2026-09-24T06:46:49.000Z').toLocaleString()}`,
    ],
  })
  // A failed connection drops out; the rest of the reading stands.
  assert.deepEqual(probe?.parse([wallet, undefined]), {
    text: '$91.43',
    lines: ['DeepSeek · Credits $91.43 left'],
  })
  assert.equal(probe?.parse([undefined, undefined]), null)
  assert.equal(probe?.parse([{ error: 'nope' }]), null)
})

test('a LiteLLM key payload reports the remaining budget, or the spend alone', () => {
  assert.deepEqual(resolveProbe('litellm')?.parse([{ key: 'sk-...', info: { spend: 1.25, max_budget: 10 } }]), {
    text: '$8.75',
    lines: ['Budget $10.00', 'Spent $1.25', 'Remaining $8.75'],
  })
  assert.deepEqual(resolveProbe('litellm')?.parse([{ info: { spend: 1.25, max_budget: null } }]), {
    text: '$1.25 spent',
    lines: ['Spent $1.25'],
  })
  assert.equal(resolveProbe('litellm')?.parse([{ error: { message: 'unknown route' } }]), null)
})

test('z.ai resolves to the coding-plan quota endpoint in both regions', () => {
  assert.equal(resolveProbe('zai')?.url, 'https://api.z.ai/api/monitor/usage/quota/limit')
  assert.equal(
    resolveProbe('bigmodel-cn', 'https://open.bigmodel.cn/api/paas/v4')?.url,
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  )
})

test('an unknown aggregator host is only ever asked for the LiteLLM key route', () => {
  assert.equal(resolveProbe('meta', 'https://api.meta.ai/v1')?.url, 'https://api.meta.ai/key/info')
  assert.equal(resolveProbe('vllm-local', 'http://192.168.0.211:8000/v1')?.url, 'http://192.168.0.211:8000/key/info')
  assert.equal(resolveProbe('unknown-route'), undefined)
})

test('a DeepSeek balance payload becomes one amount plus its breakdown', () => {
  const reading = resolveProbe('deepseek-official')?.parse([{
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  }])
  assert.deepEqual(reading, {
    text: '¥110.00',
    lines: ['Balance ¥110.00', 'Granted ¥10.00', 'Topped up ¥100.00'],
  })
})

test('a DeepSeek payload with no balance figures reads as nothing', () => {
  assert.equal(resolveProbe('deepseek-official')?.parse([{ is_available: false }]), null)
  assert.equal(resolveProbe('deepseek-official')?.parse([{ balance_infos: [] }]), null)
})

test('an OpenRouter payload reports remaining credits', () => {
  const reading = resolveProbe('openrouter')?.parse([{ data: { total_credits: 15, total_usage: 2.66 } }])
  assert.deepEqual(reading, {
    text: '$12.34',
    lines: ['Credits $15.00', 'Used $2.66', 'Remaining $12.34'],
  })
})

test('a z.ai payload reports the fullest window plus every window', () => {
  const reading = resolveProbe('zai')?.parse([{
    data: {
      level: 'GLM Coding Plan Pro',
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 42, unit: 3, number: 5, nextResetTime: Date.UTC(2026, 0, 2, 3, 0, 0) },
        { type: 'TIME_LIMIT', percentage: 7, unit: 5, number: 1 },
      ],
    },
  }])
  assert.equal(reading?.text, 'GLM 58%')
  assert.equal(reading?.lines[0], 'Plan GLM Coding Plan Pro')
  assert.match(reading?.lines[1] ?? '', /^Tokens 5h 42% used, resets /)
  assert.equal(reading?.lines[2], 'MCP tools 1mo 7% used')
})

test('a z.ai payload without quota windows reads as nothing', () => {
  assert.equal(resolveProbe('zai')?.parse([{ data: { limits: [] } }]), null)
  assert.equal(resolveProbe('zai')?.parse([{ code: 200, data: {} }]), null)
})

test('amounts are spelled with the currency the provider reports', () => {
  assert.equal(formatMoney(4.2, 'USD'), '$4.20')
  assert.equal(formatMoney(110, 'CNY'), '¥110.00')
  assert.equal(formatMoney(3.5, 'CHF'), '3.50 CHF')
  assert.equal(formatMoney(3.5), '3.50')
})

test('a subscription route resolves to its CLI credential, not to a key', () => {
  assert.equal(resolveProbe('anthropic')?.local, 'claude')
  assert.equal(resolveProbe('my-claude')?.local, 'claude')
  assert.equal(resolveProbe('codex')?.local, 'codex')
  assert.equal(resolveProbe('openai-codex')?.local, 'codex')
  assert.equal(resolveProbe('grok')?.local, 'grok')
  assert.equal(resolveProbe('xai')?.local, 'grok')
  assert.equal(resolveProbe('cursor')?.local, 'cursor')
})

test('a reseller host is never read as the vendor subscription', () => {
  // Vertex-hosted Claude names Anthropic in its route id but answers on googleapis.
  assert.equal(resolveProbe('google-vertex-anthropic', 'https://us-east5-aiplatform.googleapis.com'), undefined)
  assert.equal(resolveProbe('anthropic-proxy', 'http://192.168.0.100:20128/v1')?.local, undefined)
})

test('a Claude usage payload reports the session and every weekly window', () => {
  const reading = resolveProbe('anthropic')?.parse([{
    five_hour: { utilization: 42, resets_at: '2026-09-19T16:50:49Z' },
    limits: [
      { kind: 'weekly_all', percent: 27, resets_at: '2026-09-22T18:45:39Z' },
      { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Fable' } } },
      { kind: 'session', percent: 43, resets_at: '2026-09-19T16:50:49Z' },
    ],
    extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000 },
  }])
  assert.equal(reading?.text, 'Claude 57%')
  assert.match(reading?.lines[0] ?? '', /^Session 43% used, resets /)
  assert.match(reading?.lines[1] ?? '', /^All models 27% used, resets /)
  assert.equal(reading?.lines[2], 'Fable 9% used')
  assert.equal(reading?.lines[3], 'Extra usage $2.50 of $10.00')
})

test('a Codex usage payload reports plan, windows, and credits', () => {
  const reading = resolveProbe('codex')?.parse([{
    plan_type: 'plus_plan',
    rate_limit: {
      primary_window: { used_percent: 58, limit_window_seconds: 18_000, reset_after_seconds: 600 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604_800 },
      limit_reached: false,
    },
    credits: { has_credits: true, balance: 25 },
  }])
  assert.equal(reading?.text, 'Codex 42%')
  assert.equal(reading?.lines[0], 'Plan Plus Plan')
  assert.match(reading?.lines[1] ?? '', /^Current session 58% used, resets /)
  assert.equal(reading?.lines[2], 'Weekly 12% used')
  assert.equal(reading?.lines[3], 'Credits 25')
})

test('a Grok pair of billing payloads keeps the weekly and monthly meters', () => {
  const reading = resolveProbe('grok')?.parse([
    { config: { creditUsagePercent: 30, currentPeriod: { type: 'WEEKLY', end: '2026-09-22T00:00:00Z' } } },
    { config: { used: 250, monthlyLimit: 1000, billingPeriodEnd: '2026-10-01T00:00:00Z' } },
  ])
  assert.equal(reading?.text, 'Grok 70%')
  assert.match(reading?.lines[0] ?? '', /^Weekly 30% used, resets /)
  assert.match(reading?.lines[1] ?? '', /^Monthly \$2\.50 of \$10\.00, resets /)
})

test('a Grok reading survives one of its two meters failing', () => {
  const reading = resolveProbe('grok')?.parse([
    undefined,
    { config: { used: 100, monthlyLimit: 1000 } },
  ])
  assert.equal(reading?.text, 'Grok 90%')
  assert.equal(reading?.lines[0], 'Monthly $1.00 of $10.00')
})

test('a Cursor usage payload reports the included meter and on-demand spend', () => {
  const reading = resolveProbe('cursor')?.parse([{
    membershipType: 'pro_plus',
    billingCycleEnd: '2026-10-01T00:00:00Z',
    individualUsage: {
      plan: { used: 120, limit: 500, totalPercentUsed: 24 },
      onDemand: { used: 300, limit: 2000 },
    },
  }])
  assert.equal(reading?.text, 'Cursor 76%')
  assert.equal(reading?.lines[0], 'Plan Pro+')
  assert.match(reading?.lines[1] ?? '', /^Included 24% used, resets /)
  assert.match(reading?.lines[2] ?? '', /^On-demand 15% used, resets /)
})

test('an unlimited Cursor plan says so instead of inventing a percentage', () => {
  const reading = resolveProbe('cursor')?.parse([{ membershipType: 'business', isUnlimited: true }])
  assert.deepEqual(reading, { text: 'Cursor unlimited', lines: ['Plan Business'] })
})
