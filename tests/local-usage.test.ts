/**
 * Local CLI credentials: the files each provider reads, the headers that come
 * out of them, and the rotation that must leave the CLI still signed in. Every
 * case runs against a temporary home directory; no real ~/.claude, ~/.codex,
 * ~/.grok, or Cursor file is touched, and a fetch stub stands in for the
 * vendor's token endpoint.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { localRequests } from '../src/local-usage.ts'

/** Gitignored scratch root at the repository root: temporary homes live here, never in /tmp. */
const SCRATCH = fileURLToPath(new URL('../.scratch/', import.meta.url))
mkdirSync(SCRATCH, { recursive: true })

/** Token-request deadline; the stubbed endpoints answer at once. */
const TIMEOUT_MS = 1_000

/** One stubbed HTTP response. */
interface StubResponse {
  status: number
  body?: unknown
}

/** Replace global fetch with a URL-keyed stub; returns the calls and a restore. */
function stubFetch(routes: Readonly<Record<string, StubResponse>>): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const key = String(url)
    calls.push(key)
    const route = routes[key] ?? { status: 404 }
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: () => Promise.resolve(route.body ?? null),
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** One unsigned JWT carrying the payload a vendor would sign. */
function jwt(payload: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

/** A fresh temporary home directory, removed by the returned disposer. */
async function temporaryHome(): Promise<{ home: string; dispose: () => Promise<void> }> {
  const home = await mkdtemp(join(SCRATCH, 'quota-check-test-'))
  return { home, dispose: async () => { await rm(home, { recursive: true, force: true }) } }
}

/** Write one credential file, creating its directory. */
async function writeCredential(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

test('a live Claude Code token becomes the usage request, with Claude Code headers', async () => {
  const { home, dispose } = await temporaryHome()
  try {
    await writeCredential(join(home, '.claude', '.credentials.json'), {
      claudeAiOauth: { accessToken: 'live-token', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
      otherField: 'kept',
    })
    const requests = await localRequests('claude', { home, timeoutMs: TIMEOUT_MS })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(requests[0]?.headers['authorization'], 'Bearer live-token')
    assert.equal(requests[0]?.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(requests[0]?.headers['user-agent'], 'claude-code/2.1.251')
  } finally {
    await dispose()
  }
})

test('an expired Claude token rotates in place and keeps every other field', async () => {
  const { home, dispose } = await temporaryHome()
  const path = join(home, '.claude', '.credentials.json')
  const stub = stubFetch({
    'https://platform.claude.com/v1/oauth/token': {
      status: 200,
      body: { access_token: 'rotated', refresh_token: 'r2', expires_in: 3_600 },
    },
  })
  try {
    await writeCredential(path, {
      claudeAiOauth: { accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() - 1_000 },
      subscriptionType: 'max',
    })
    const requests = await localRequests('claude', { home, timeoutMs: TIMEOUT_MS })
    assert.equal(stub.calls.length, 1)
    assert.equal(requests[0]?.headers['authorization'], 'Bearer rotated')
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      subscriptionType: string
      claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number }
    }
    assert.equal(stored.subscriptionType, 'max')
    assert.equal(stored.claudeAiOauth.accessToken, 'rotated')
    assert.equal(stored.claudeAiOauth.refreshToken, 'r2')
    assert.ok(stored.claudeAiOauth.expiresAt > Date.now(), 'the new expiry is written back')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    stub.restore()
    await chmod(path, 0o600).catch(() => {})
    await dispose()
  }
})

test('concurrent aliases share a credential refresh without losing edits made during it', async () => {
  const { home, dispose } = await temporaryHome()
  const path = join(home, '.claude', '.credentials.json')
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    const latest = JSON.parse(await readFile(path, 'utf8'))
    latest.subscriptionType = 'new-plan'
    latest.claudeAiOauth.scopes = ['new-scope']
    await writeCredential(path, latest)
    await new Promise(resolve => setTimeout(resolve, 20))
    return Response.json({ access_token: 'rotated', refresh_token: 'r2', expires_in: 3_600 })
  }) as typeof fetch
  try {
    await writeCredential(path, {
      claudeAiOauth: { accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() - 1_000 },
      subscriptionType: 'old-plan',
    })
    const results = await Promise.all([1, 2].map(() => localRequests('claude', { home, timeoutMs: TIMEOUT_MS })))
    assert.equal(calls, 1, 'one expired token must not be refreshed twice concurrently')
    assert.ok(results.every(requests => requests[0]?.headers['authorization'] === 'Bearer rotated'))
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(stored.subscriptionType, 'new-plan')
    assert.deepEqual(stored.claudeAiOauth.scopes, ['new-scope'])
  } finally {
    globalThis.fetch = original
    await dispose()
  }
})

test('rotation preserves current fields and does not overwrite a new or removed CLI login', async () => {
  const entries = [
    { provider: 'claude', file: ['.claude', '.credentials.json'], field: 'claudeAiOauth', access: 'accessToken',
      value: { accessToken: 'stale', refreshToken: 'r', expiresAt: 1 } },
    { provider: 'codex', file: ['.codex', 'auth.json'], field: 'tokens', access: 'access_token',
      value: { access_token: jwt({ exp: 1 }), refresh_token: 'r' } },
    { provider: 'grok', file: ['.grok', 'auth.json'], field: 'user::client', access: 'key',
      value: { key: 'stale', refresh_token: 'r', expires_at: '2000-01-01T00:00:00Z' } },
  ] as const
  for (const entry of entries) for (const change of ['edit', 'login', 'remove'] as const) {
    const { home, dispose } = await temporaryHome()
    const path = join(home, ...entry.file)
    const original = globalThis.fetch
    globalThis.fetch = (async (url) => {
      if (String(url).includes('openid-configuration')) return Response.json({ token_endpoint: 'https://auth.x.ai/token' })
      if (change === 'remove') await rm(path)
      else {
        const current = JSON.parse(await readFile(path, 'utf8'))
        current.extra = 'changed'
        current[entry.field].scopes = ['new-scope']
        if (change === 'login') current[entry.field][entry.access] = 'new-login'
        await writeCredential(path, current)
      }
      return Response.json({ access_token: 'rotated', refresh_token: 'r2', expires_in: 3600 })
    }) as typeof fetch
    try {
      await writeCredential(path, { [entry.field]: entry.value, extra: 'old' })
      await localRequests(entry.provider, { home, timeoutMs: TIMEOUT_MS })
      if (change === 'remove') await assert.rejects(readFile(path), { code: 'ENOENT' })
      else {
        const stored = JSON.parse(await readFile(path, 'utf8'))
        assert.equal(stored.extra, 'changed', entry.provider)
        assert.deepEqual(stored[entry.field].scopes, ['new-scope'], entry.provider)
        assert.equal(stored[entry.field][entry.access], change === 'login' ? 'new-login' : 'rotated', entry.provider)
      }
    } finally {
      globalThis.fetch = original
      await dispose()
    }
  }
})

test('an expired Codex token rotates, and the account id rides every request', async () => {
  const { home, dispose } = await temporaryHome()
  const path = join(home, '.codex', 'auth.json')
  const accountId = 'acct-from-jwt'
  const stub = stubFetch({
    'https://auth.openai.com/oauth/token': {
      status: 200,
      body: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }), id_token: 'id-2' },
    },
  })
  try {
    await writeCredential(path, {
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
        refresh_token: 'refresh-1',
      },
      other: true,
    })
    const requests = await localRequests('codex', { home, timeoutMs: TIMEOUT_MS })
    assert.equal(stub.calls.length, 1)
    assert.equal(requests[0]?.url, 'https://chatgpt.com/backend-api/wham/usage')
    assert.equal(requests[0]?.headers['chatgpt-account-id'], accountId)
    assert.match(String(requests[0]?.headers['authorization']), /^Bearer /)
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      other: boolean
      last_refresh: string
      tokens: { refresh_token: string; id_token: string }
    }
    assert.equal(stored.other, true)
    assert.equal(stored.tokens.refresh_token, 'refresh-1')
    assert.equal(stored.tokens.id_token, 'id-2')
    assert.ok(stored.last_refresh.length > 0)
  } finally {
    stub.restore()
    await dispose()
  }
})

test('Grok reads the newest account entry and asks both billing meters', async () => {
  const { home, dispose } = await temporaryHome()
  try {
    await writeCredential(join(home, '.grok', 'auth.json'), {
      'old::client-a': { key: 'token-old', expires_at: '2026-01-01T00:00:00Z' },
      'new::client-b': { key: 'token-new', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' },
    })
    const requests = await localRequests('grok', { home, timeoutMs: TIMEOUT_MS })
    assert.deepEqual(requests.map(request => request.url), [
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/billing',
    ])
    assert.equal(requests[0]?.headers['authorization'], 'Bearer token-new')
  } finally {
    await dispose()
  }
})

test('Grok compares expiry instants and skips entries without usable tokens', async () => {
  const { home, dispose } = await temporaryHome()
  try {
    await writeCredential(join(home, '.grok', 'auth.json'), {
      'earlier::client': { key: 'earlier', expires_at: '2030-01-01T10:00:00+10:00' },
      'later::client': { key: 'later', expires_at: '2030-01-01T01:00:00Z' },
      'broken::client': { key: {}, expires_at: '2031-01-01T00:00:00Z' },
    })
    const requests = await localRequests('grok', { home, timeoutMs: TIMEOUT_MS })
    assert.equal(requests[0]?.headers['authorization'], 'Bearer later')
  } finally { await dispose() }
})

test('an expired Grok token is refreshed through the discovered OIDC endpoint', async () => {
  const { home, dispose } = await temporaryHome()
  const path = join(home, '.grok', 'auth.json')
  const stub = stubFetch({
    'https://auth.x.ai/.well-known/openid-configuration': {
      status: 200,
      body: { token_endpoint: 'https://auth.x.ai/oauth2/token' },
    },
    'https://auth.x.ai/oauth2/token': {
      status: 200,
      body: { access_token: 'rotated-grok', expires_in: 3_600 },
    },
  })
  try {
    await writeCredential(path, {
      'user::client-b': {
        key: 'stale-grok',
        refresh_token: 'refresh-grok',
        oidc_client_id: 'client-b',
        expires_at: '2020-01-01T00:00:00Z',
      },
    })
    const requests = await localRequests('grok', { home, timeoutMs: TIMEOUT_MS })
    assert.deepEqual(stub.calls, [
      'https://auth.x.ai/.well-known/openid-configuration',
      'https://auth.x.ai/oauth2/token',
    ])
    assert.equal(requests[0]?.headers['authorization'], 'Bearer rotated-grok')
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, { key: string; refresh_token: string }>
    assert.equal(stored['user::client-b']?.key, 'rotated-grok')
    assert.equal(stored['user::client-b']?.refresh_token, 'refresh-grok')
  } finally {
    stub.restore()
    await dispose()
  }
})

test('Cursor sends its session cookie built from the token subject', async () => {
  const { home, dispose } = await temporaryHome()
  const previous = process.env['CURSOR_AUTH_JSON']
  try {
    delete process.env['CURSOR_AUTH_JSON']
    await writeCredential(join(home, '.config', 'cursor', 'auth.json'), {
      accessToken: jwt({ sub: 'auth0|user_01abc' }),
    })
    const requests = await localRequests('cursor', { home, timeoutMs: TIMEOUT_MS })
    assert.equal(requests[0]?.url, 'https://cursor.com/api/usage-summary')
    const cookie = String(requests[0]?.headers['cookie'])
    assert.match(cookie, /^WorkosCursorSessionToken=user_01abc%3A%3A/)
    assert.equal(requests[0]?.headers['origin'], 'https://cursor.com')
  } finally {
    if (previous !== undefined) process.env['CURSOR_AUTH_JSON'] = previous
    await dispose()
  }
})

test('a machine with no CLI credential asks nothing', async () => {
  const { home, dispose } = await temporaryHome()
  const previous = process.env['CURSOR_AUTH_JSON']
  try {
    delete process.env['CURSOR_AUTH_JSON']
    for (const provider of ['claude', 'codex', 'grok', 'cursor'] as const) {
      assert.deepEqual(await localRequests(provider, { home, timeoutMs: TIMEOUT_MS }), [], provider)
    }
  } finally {
    if (previous !== undefined) process.env['CURSOR_AUTH_JSON'] = previous
    await dispose()
  }
})
