/**
 * Local CLI credentials for the subscription providers: where the token lives,
 * when it is stale, how it rotates, and the exact headers the vendor's usage
 * endpoint expects.
 *
 * These four providers bill a plan, not a key, so there is no settings API key
 * to resolve: the token already sits on this machine, written by the CLI the
 * human signed into. This module is the port of `quota-widget`'s fetchers
 * (`~/Desktop/Projects/quota-widget/package/contents/code/fetch_quota.py`);
 * it keeps the observable behavior — file paths, expiry skews, refresh bodies,
 * and the write-back that keeps the CLI itself signed in — and drops the parts
 * a statusbar chip does not need (disk caches, Retry-After sleeps, the TUI
 * JSON shape).
 *
 * Rotation writes back only through an atomic replace in the file's own
 * directory, mode 0600, preserving every other field, so a crash mid-write can
 * never leave a CLI with a truncated credential.
 *
 * @module dsh-quota-check/local-usage
 */

import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isoToMs, numberOf, record, stringOf } from './util.ts'

/** The subscription providers whose credentials live on this machine. */
export type LocalProvider = 'claude' | 'codex' | 'grok' | 'cursor'

/** One outbound request built from a local credential. */
export interface LocalRequest {
  /** Absolute URL to GET. */
  readonly url: string
  /** Headers the vendor expects, including the credential itself. */
  readonly headers: Readonly<Record<string, string>>
}

/** Options for reading a local credential. */
export interface LocalOptions {
  /** Home directory the CLI files hang off; defaults to the running user's. */
  readonly home?: string
  /** Refresh even when the token looks unexpired; the 401 retry path uses this. */
  readonly forceRefresh?: boolean
}

/** This plugin's own User-Agent for token endpoints. */
const USER_AGENT = 'dsh-quota-check/0.1'

/** Claude Code's own User-Agent: Anthropic rate-limits the usage endpoint per agent. */
const CLAUDE_USER_AGENT = 'claude-code/2.1.251'

const CLAUDE_CREDENTIALS = ['.claude', '.credentials.json']
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
]

const CODEX_AUTH = ['.codex', 'auth.json']
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const GROK_AUTH = ['.grok', 'auth.json']
const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing'
const GROK_OIDC_DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration'

const CURSOR_AUTH_JSON = ['.config', 'cursor', 'auth.json']
const CURSOR_SUMMARY_URL = 'https://cursor.com/api/usage-summary'

/** Token refresh happens this close to expiry, in milliseconds / seconds. */
const TOKEN_SKEW_MS = 120_000
const TOKEN_SKEW_S = 120

/** Epoch values above this are milliseconds; below it, seconds. */
const MS_EPOCH_CUTOFF = 10_000_000_000

/** Read and decode one JSON file, or `undefined` when absent or unreadable. */
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Atomically replace one JSON file, privately, keeping other fields intact. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const staged = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(staged, 0o600)
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => { /* already gone */ })
    throw error
  }
}

/** Decoded JWT payload, or `undefined` for an opaque or malformed token. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1]
  if (part === undefined) return undefined
  try {
    const padding = '='.repeat((4 - (part.length % 4)) % 4)
    return record(JSON.parse(Buffer.from(part + padding, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

/** Read one nested JWT claim, or `undefined`. */
function jwtClaim(token: string, ...path: readonly string[]): unknown {
  let current: unknown = jwtPayload(token)
  for (const key of path) {
    current = record(current)?.[key]
  }
  return current
}

/** JWT `exp` as epoch milliseconds, or `undefined`. */
function jwtExpiryMs(token: string): number | undefined {
  const exp = numberOf(jwtClaim(token, 'exp'))
  return exp === undefined ? undefined : exp * 1_000
}

/** POST one token request and decode the reply with its status. */
async function requestToken(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { method: 'POST', headers, body })
    if (!response.ok) return { status: response.status }
    return { status: response.status, body: record(await response.json().catch(() => undefined)) }
  } catch {
    return { status: 0 }
  }
}

/** Form-encode a token refresh body. */
function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString()
}

/**
 * Claude Code's OAuth credential and usage request.
 * @param home - home directory holding `.claude`.
 * @param force - refresh even when the token looks live.
 * @returns the usage request, or `[]` when no credential is usable.
 */
async function claudeRequests(home: string, force: boolean): Promise<readonly LocalRequest[]> {
  const path = join(home, ...CLAUDE_CREDENTIALS)
  let credentials = await readJson(path)
  let oauth = record(record(credentials)?.['claudeAiOauth'])
  if (oauth === undefined) return []
  let token = stringOf(oauth['accessToken'])
  if (token === undefined) return []

  const expiresAt = numberOf(oauth['expiresAt'])
  const expiresMs = expiresAt === undefined
    ? undefined
    : expiresAt > MS_EPOCH_CUTOFF ? expiresAt : expiresAt * 1_000
  if (force || (expiresMs !== undefined && expiresMs <= Date.now() + TOKEN_SKEW_MS)) {
    const refreshToken = stringOf(oauth['refreshToken'])
    if (refreshToken !== undefined) {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      })
      for (const url of CLAUDE_TOKEN_URLS) {
        const rotated = await requestToken(url, {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        }, body)
        // A refused refresh is a refused refresh: the second host would answer
        // the same, and Anthropic counts the attempts.
        if (rotated.status === 400 || rotated.status === 401) break
        const access = stringOf(rotated.body?.['access_token'])
        if (access === undefined) continue
        const next: Record<string, unknown> = { ...oauth, accessToken: access }
        const rotatedRefresh = stringOf(rotated.body?.['refresh_token'])
        if (rotatedRefresh !== undefined) next['refreshToken'] = rotatedRefresh
        const expiresIn = numberOf(rotated.body?.['expires_in'])
        if (expiresIn !== undefined) next['expiresAt'] = Date.now() + expiresIn * 1_000
        const updated = { ...record(credentials), claudeAiOauth: next }
        await writeJson(path, updated).catch(() => { /* serve the live token anyway */ })
        oauth = next
        token = access
        break
      }
    }
  }
  if (token === undefined) return []
  return [{
    url: CLAUDE_USAGE_URL,
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'user-agent': CLAUDE_USER_AGENT,
      accept: 'application/json',
    },
  }]
}

/**
 * Codex (ChatGPT subscription) credential and usage request.
 * @param home - home directory holding `.codex`.
 * @param force - refresh even when the token looks live.
 * @returns the usage request, or `[]` when no credential is usable.
 */
async function codexRequests(home: string, force: boolean): Promise<readonly LocalRequest[]> {
  const path = join(home, ...CODEX_AUTH)
  let auth = record(await readJson(path))
  if (auth === undefined) return []
  let tokens = record(auth['tokens'])
  let access = stringOf(tokens?.['access_token'])
  if (access === undefined) return []
  let account = stringOf(tokens?.['account_id'])
    ?? stringOf(jwtClaim(access, 'https://api.openai.com/auth', 'chatgpt_account_id'))

  const expiresMs = jwtExpiryMs(access)
  const refreshToken = stringOf(tokens?.['refresh_token'])
  if (refreshToken !== undefined
    && (force || (expiresMs !== undefined && expiresMs <= Date.now() + TOKEN_SKEW_MS))) {
    const rotated = await requestToken(CODEX_TOKEN_URL, {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }, formBody({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }))
    const rotatedAccess = stringOf(rotated.body?.['access_token'])
    if (rotatedAccess !== undefined) {
      const nextTokens: Record<string, unknown> = { ...tokens, access_token: rotatedAccess }
      const rotatedRefresh = stringOf(rotated.body?.['refresh_token'])
      if (rotatedRefresh !== undefined) nextTokens['refresh_token'] = rotatedRefresh
      const rotatedId = stringOf(rotated.body?.['id_token'])
      if (rotatedId !== undefined) nextTokens['id_token'] = rotatedId
      const updated = { ...auth, tokens: nextTokens, last_refresh: new Date().toISOString() }
      await writeJson(path, updated).catch(() => { /* serve the live token anyway */ })
      auth = updated
      tokens = nextTokens
      access = rotatedAccess
      account = stringOf(nextTokens['account_id']) ?? account
    }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${access}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  if (account !== undefined) headers['chatgpt-account-id'] = account
  return [{ url: CODEX_USAGE_URL, headers }]
}

/** Grok's newest OIDC entry, with the key it is stored under. */
function newestGrokEntry(store: Record<string, unknown>): { key: string; entry: Record<string, unknown> } | undefined {
  let best: { key: string; entry: Record<string, unknown> } | undefined
  let bestExpiry = ''
  for (const [key, value] of Object.entries(store)) {
    const entry = record(value)
    if (entry === undefined || entry['key'] === undefined) continue
    const expiry = typeof entry['expires_at'] === 'string' ? entry['expires_at'] : ''
    if (best === undefined || expiry > bestExpiry) {
      best = { key, entry }
      bestExpiry = expiry
    }
  }
  return best
}

/**
 * Grok's OIDC credential and the two billing meters (weekly credits, monthly spend).
 * @param home - home directory holding `.grok`.
 * @param force - refresh even when the token looks live.
 * @returns the billing requests, or `[]` when no credential is usable.
 */
async function grokRequests(home: string, force: boolean): Promise<readonly LocalRequest[]> {
  const path = join(home, ...GROK_AUTH)
  const store = record(await readJson(path))
  if (store === undefined) return []
  const found = newestGrokEntry(store)
  if (found === undefined) return []
  let { entry } = found
  let token = stringOf(entry['key'])
  if (token === undefined) return []

  const expiresMs = isoToMs(entry['expires_at'])
  const refreshToken = stringOf(entry['refresh_token'])
  const clientId = stringOf(entry['oidc_client_id'])
    ?? (found.key.includes('::') ? found.key.split('::')[1] : undefined)
  if (clientId !== undefined && refreshToken !== undefined
    && (force || (expiresMs !== undefined && expiresMs <= Date.now() + TOKEN_SKEW_S * 1_000))) {
    let rotated: { status: number; body?: Record<string, unknown> } = { status: 0 }
    try {
      const discovery = record(await (await fetch(GROK_OIDC_DISCOVERY, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      })).json())
      const tokenUrl = stringOf(discovery?.['token_endpoint'])
      if (tokenUrl !== undefined) {
        rotated = await requestToken(tokenUrl, {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        }, formBody({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }))
      }
    } catch {
      rotated = { status: 0 }
    }
    const rotatedAccess = stringOf(rotated.body?.['access_token'])
    if (rotatedAccess !== undefined) {
      const next: Record<string, unknown> = { ...entry, key: rotatedAccess }
      const rotatedRefresh = stringOf(rotated.body?.['refresh_token'])
      if (rotatedRefresh !== undefined) next['refresh_token'] = rotatedRefresh
      const expiresIn = numberOf(rotated.body?.['expires_in'])
      if (expiresIn !== undefined) {
        next['expires_at'] = new Date(Date.now() + expiresIn * 1_000).toISOString()
      }
      // Grok re-reads its own file before writing: another process may have
      // rotated a different account entry while this one was in flight.
      const latest = record(await readJson(path)) ?? {}
      latest[found.key] = next
      await writeJson(path, latest).catch(() => { /* serve the live token anyway */ })
      entry = next
      token = rotatedAccess
    }
  }
  if (token === undefined) return []
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  return [
    { url: `${GROK_BILLING_URL}?format=credits`, headers },
    { url: GROK_BILLING_URL, headers },
  ]
}

/** Cursor's IDE database path for this platform. */
function cursorStateDb(home: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    return join(appData ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  const xdg = process.env['XDG_CONFIG_HOME']
  return join(xdg ?? join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** Decode one `ItemTable` cell: raw text, bytes, or a JSON-quoted string. */
function cellString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const raw = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value)
  const text = raw.trim()
  if (text === '') return undefined
  if (text.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(text)
      if (typeof decoded === 'string') return decoded
    } catch {
      return text
    }
  }
  return text
}

/** Cursor's token and plan from the IDE database, or `undefined`. */
async function cursorFromStateDb(path: string): Promise<{ token: string; plan: string } | undefined> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(path, { readOnly: true, timeout: 1_000 })
    try {
      const rows = database.prepare(
        'SELECT key, value FROM ItemTable WHERE key IN (?, ?)',
      ).all('cursorAuth/accessToken', 'cursorAuth/stripeMembershipType')
      const cells = new Map<string, string | undefined>()
      for (const row of rows) {
        const entry = record(row)
        const key = cellString(entry?.['key'])
        if (key !== undefined) cells.set(key, cellString(entry?.['value']))
      }
      const token = cells.get('cursorAuth/accessToken')
      if (token === undefined) return undefined
      return { token, plan: cells.get('cursorAuth/stripeMembershipType') ?? '' }
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Cursor's session credential and usage request. Cursor has no refresh path:
 * the session token is long-lived and only the IDE or `cursor-agent` rotates it.
 * @param home - home directory holding `.config`.
 * @returns the usage request, or `[]` when no credential is usable.
 */
async function cursorRequests(home: string): Promise<readonly LocalRequest[]> {
  const fromJson = async (path: string): Promise<string | undefined> =>
    stringOf(record(await readJson(path))?.['accessToken'])
  const override = process.env['CURSOR_AUTH_JSON']
  let token = override === undefined || override === '' ? undefined : await fromJson(override)
  token ??= await fromJson(join(home, ...CURSOR_AUTH_JSON))
  if (token === undefined) token = (await cursorFromStateDb(cursorStateDb(home)))?.token
  if (token === undefined) return []
  // The cookie carries the WorkOS user id, which only the token's `sub` names.
  const sub = stringOf(jwtClaim(token, 'sub'))
  if (sub === undefined) return []
  const user = sub.includes('|') ? sub.slice(sub.lastIndexOf('|') + 1) : sub
  return [{
    url: CURSOR_SUMMARY_URL,
    headers: {
      cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${token}`)}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
      origin: 'https://cursor.com',
      referer: 'https://cursor.com/dashboard/usage',
    },
  }]
}

/**
 * Build the outbound requests for one subscription provider.
 * @param provider - which CLI credential to read.
 * @param options - home directory and forced-refresh flag.
 * @returns one or two requests, or `[]` when nothing usable is on disk.
 */
export async function localRequests(
  provider: LocalProvider,
  options: LocalOptions = {},
): Promise<readonly LocalRequest[]> {
  const home = options.home ?? homedir()
  const force = options.forceRefresh === true
  switch (provider) {
    case 'claude': return await claudeRequests(home, force)
    case 'codex': return await codexRequests(home, force)
    case 'grok': return await grokRequests(home, force)
    case 'cursor': return await cursorRequests(home)
  }
}
