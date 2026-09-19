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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localRequests } from '../src/local-usage.ts'

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
  const home = await mkdtemp(join(tmpdir(), 'quota-check-test-'))
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
    const requests = await localRequests('claude', { home })
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
    const requests = await localRequests('claude', { home })
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
    const requests = await localRequests('codex', { home })
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
    const requests = await localRequests('grok', { home })
    assert.deepEqual(requests.map(request => request.url), [
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/billing',
    ])
    assert.equal(requests[0]?.headers['authorization'], 'Bearer token-new')
  } finally {
    await dispose()
  }
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
    const requests = await localRequests('grok', { home })
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
    const requests = await localRequests('cursor', { home })
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
      assert.deepEqual(await localRequests(provider, { home }), [], provider)
    }
  } finally {
    if (previous !== undefined) process.env['CURSOR_AUTH_JSON'] = previous
    await dispose()
  }
})
