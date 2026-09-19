/**
 * Provider quota/balance probes: which endpoint answers for a provider route,
 * and how its payload becomes one statusbar line plus tooltip detail.
 *
 * A probe resolves from a provider id and an optional configured base URL, and
 * a parser turns a decoded JSON payload into a {@link ProbeReading}. Host-only
 * concerns — credentials, HTTP, caching — live in `index.ts`, which is what
 * makes these rules testable without a network. One exception: an endpoint whose
 * ids the configuration cannot name (OmniRoute asks per upstream connection)
 * declares `requests`, which reads the listing before the host asks each id.
 *
 * Four endpoints report a *server-side* figure: DeepSeek's `/user/balance`,
 * OpenRouter's `/credits`, the z.ai / BigModel Coding Plan quota, and LiteLLM's
 * `/key/info` (spend and remaining budget for the calling key). LiteLLM is also
 * the fallback for any otherwise-unknown route with a configured base URL,
 * because a proxy deployment names its routes after the models it serves, not
 * after the proxy — an unknown host that answers `/key/info` is a LiteLLM. A
 * route whose host publishes neither resolves no probe and the statusbar stays
 * empty.
 *
 * @module dsh-quota-check/probes
 */

import type { LocalProvider, LocalRequest } from './local-usage.ts'
import { isoToMs, numberOf, record, stringOf } from './util.ts'

/** Short reading for one provider: the chip text and its tooltip lines. */
export interface ProbeReading {
  /** Compact statusbar text, e.g. `¥110.00` or `GLM 58%`. */
  readonly text: string
  /** Tooltip detail lines, in display order. */
  readonly lines: readonly string[]
  /** Remaining quota as a percentage, when the reading is a metered quota. */
  readonly remaining?: number
}

/** Remaining percent of a used-percent reading, for countdown chips. */
function remainingOf(usedPercent: number): number {
  return Math.round(100 - usedPercent)
}

/** What one provider reports: a spendable balance, or a plan quota. */
export type ProbeKind = 'balance' | 'quota'

/**
 * The bodies a probe asked for, aligned with its requests: `undefined` marks a
 * request that failed, so a two-meter provider (Grok's weekly and monthly
 * calls) still reports when only one of them answered.
 */
export type ProbePayloads = readonly (unknown | undefined)[]

/** What a probe that discovers its own endpoints is handed. */
export interface ProbeExpandContext {
  /** The route's resolved credential. */
  readonly key: string
  /** Per-request deadline in milliseconds, for the listing request itself. */
  readonly timeoutMs: number
}

/**
 * Build a probe's requests from an earlier answer, for endpoints whose ids the
 * route's configuration cannot name.
 * @param context - the credential and deadline to list with.
 * @returns the requests to ask, in the order their payloads arrive.
 */
export type ProbeExpander = (context: ProbeExpandContext) => Promise<readonly LocalRequest[]>

/** Everything a probe shares, whatever its credential source. */
interface ProbeBase {
  /** Which kind of figure this is. */
  readonly kind: ProbeKind
  /** Credential references tried when the provider configuration names none. */
  readonly envNames?: readonly string[]
  /**
   * Requests discovered from an earlier answer, for a route whose endpoint
   * names an id only the provider itself knows.
   */
  readonly requests?: ProbeExpander
  /**
   * Turn the decoded payloads into a reading.
   * @param payloads - decoded JSON bodies, in request order.
   * @returns the reading, or `null` when none carries a usable figure.
   */
  parse(payloads: ProbePayloads): ProbeReading | null
}

/**
 * One probe: the endpoint it reads, and the credential that endpoint expects.
 * A key probe fetches one URL with a bearer token resolved from settings; a
 * local probe reads the subscription credential a CLI left on this machine and
 * may ask two endpoints of the same account.
 */
export type Probe = ProbeBase & (
  | {
    /**
     * Absolute URL to GET with the provider's bearer credential. Absent when
     * the probe discovers its own requests instead.
     */
    readonly url?: string
    readonly local?: undefined
  }
  | {
    /** Local CLI credential this endpoint reads instead of a settings key. */
    readonly local: LocalProvider
    readonly url?: undefined
  }
)

/** Currency symbols the statusbar spells instead of the ISO code. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  CNY: '¥',
  RMB: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
}

/** Model-facing label per z.ai limit type. */
const ZAI_LIMIT_LABELS: Readonly<Record<string, string>> = {
  TOKENS_LIMIT: 'Tokens',
  CREDIT_LIMIT: 'Credits',
  TIME_LIMIT: 'MCP tools',
}

/** z.ai window unit codes, as the quota endpoint reports them. */
const ZAI_WINDOW_UNITS: Readonly<Record<number, string>> = {
  1: 's',
  2: 'm',
  3: 'h',
  4: 'd',
  5: 'mo',
  6: 'w',
}

/** Provider ids that resolve to the z.ai / BigModel Coding Plan quota. */
const ZAI_IDS = new Set(['zai', 'z-ai', 'z_ai', 'zhipu', 'zhipuai', 'bigmodel', 'glm', 'glm-coding', 'zai-coding'])

/**
 * Format an amount for the statusbar.
 * @param amount - absolute amount.
 * @param currency - ISO currency code, when the provider reports one.
 * @returns symbol-prefixed amount with two decimals, or the amount with its code.
 */
export function formatMoney(amount: number, currency?: string): string {
  const digits = (Math.round(amount * 100) / 100).toFixed(2)
  const code = currency?.toUpperCase() ?? ''
  const symbol = CURRENCY_SYMBOLS[code]
  if (symbol !== undefined) return `${symbol}${digits}`
  return code === '' ? digits : `${digits} ${code}`
}

/** Origin of a configured base URL, or the provider's own default. */
function originOf(baseURL: string | undefined, fallback: string): string {
  if (baseURL === undefined) return fallback
  try {
    return new URL(baseURL).origin
  } catch {
    return fallback
  }
}

/** Host of a configured base URL, lowercased and dot-stripped. */
function hostOf(baseURL: string | undefined): string {
  if (baseURL === undefined) return ''
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Parse DeepSeek's `/user/balance` payload: `balance_infos[]`, one per currency. */
function parseDeepSeekBalance(payload: unknown): ProbeReading | null {
  const infos = record(payload)?.['balance_infos']
  if (!Array.isArray(infos)) return null
  const lines: string[] = []
  let text: string | undefined
  for (const entry of infos) {
    const info = record(entry)
    if (info === undefined) continue
    const total = numberOf(info['total_balance'])
    if (total === undefined) continue
    const currency = stringOf(info['currency']) ?? 'CNY'
    const shown = formatMoney(total, currency)
    text ??= shown
    lines.push(`Balance ${shown}`)
    const granted = numberOf(info['granted_balance'])
    if (granted !== undefined) lines.push(`Granted ${formatMoney(granted, currency)}`)
    const toppedUp = numberOf(info['topped_up_balance'])
    if (toppedUp !== undefined) lines.push(`Topped up ${formatMoney(toppedUp, currency)}`)
  }
  return text === undefined ? null : { text, lines }
}

/** Parse OpenRouter's `/credits` payload: credits bought minus usage. */
function parseOpenRouterCredits(payload: unknown): ProbeReading | null {
  const data = record(record(payload)?.['data'])
  const total = numberOf(data?.['total_credits'])
  const used = numberOf(data?.['total_usage'])
  if (total === undefined || used === undefined) return null
  const remaining = total - used
  return {
    text: formatMoney(remaining, 'USD'),
    lines: [
      `Credits ${formatMoney(total, 'USD')}`,
      `Used ${formatMoney(used, 'USD')}`,
      `Remaining ${formatMoney(remaining, 'USD')}`,
    ],
  }
}

/** Window length one z.ai limit covers, e.g. `5h` or `1w`; empty when unreported. */
function windowSuffix(limit: Record<string, unknown>): string {
  const number = numberOf(limit['number'])
  const unit = numberOf(limit['unit'])
  if (number === undefined || unit === undefined) return ''
  const suffix = ZAI_WINDOW_UNITS[unit]
  return suffix === undefined ? '' : ` ${String(number)}${suffix}`
}

/** Parse a z.ai / BigModel `quota/limit` payload: `data.limits[]` windows. */
function parseZaiQuota(payload: unknown): ProbeReading | null {
  const data = record(record(payload)?.['data'])
  const limits = data?.['limits']
  if (!Array.isArray(limits)) return null
  const windows: { label: string; percent: number; reset: string }[] = []
  for (const entry of limits) {
    const limit = record(entry)
    if (limit === undefined) continue
    const percent = numberOf(limit['percentage'])
    if (percent === undefined) continue
    const type = stringOf(limit['type']) ?? 'Quota'
    const label = `${ZAI_LIMIT_LABELS[type] ?? type}${windowSuffix(limit)}`
    windows.push({ label, percent, reset: resetSuffixFrom(numberOf(limit['nextResetTime'])) })
  }
  if (windows.length === 0) return null
  const worst = windows.reduce((left, right) => (right.percent > left.percent ? right : left))
  const plan = stringOf(data?.['planName'])
    ?? stringOf(data?.['plan'])
    ?? stringOf(data?.['plan_type'])
    ?? stringOf(data?.['level'])
  const lines = windows.map(window => `${window.label} ${Math.round(window.percent)}% used${window.reset}`)
  return {
    text: `GLM ${remainingOf(worst.percent)}%`,
    remaining: remainingOf(worst.percent),
    lines: plan === undefined ? lines : [`Plan ${plan}`, ...lines],
  }
}

/** Parse a LiteLLM `/key/info` payload: spend and the key's budget ceiling. */
function parseLiteLlmKeyInfo(payload: unknown): ProbeReading | null {
  const info = record(record(payload)?.['info'])
  if (info === undefined) return null
  const spend = numberOf(info['spend'])
  const budget = numberOf(info['max_budget'])
  if (spend === undefined && budget === undefined) return null
  const spent = spend ?? 0
  const remaining = budget === undefined ? undefined : budget - spent
  const lines: string[] = []
  if (budget !== undefined) lines.push(`Budget ${formatMoney(budget, 'USD')}`)
  lines.push(`Spent ${formatMoney(spent, 'USD')}`)
  if (remaining !== undefined) lines.push(`Remaining ${formatMoney(remaining, 'USD')}`)
  const reset = stringOf(info['budget_reset_at'])
  if (reset !== undefined) lines.push(`Resets ${reset}`)
  return {
    text: remaining === undefined ? `${formatMoney(spent, 'USD')} spent` : formatMoney(remaining, 'USD'),
    lines,
  }
}

/** Most meter lines the OmniRoute tooltip lists before it summarizes the rest. */
const MAX_OMNIROUTE_LINES = 12

/** OmniRoute's connection listing, and the usage path one listed id appends to. */
const OMNIROUTE_CONNECTIONS_PATH = '/api/providers'
const OMNIROUTE_USAGE_PATH = '/api/usage/'

/** Window names OmniRoute spells in snake_case, as the tooltip should read them. */
const OMNIROUTE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  credits_usd: 'Credits',
}

/** A window name as the tooltip spells it, e.g. `Session (5h)`. */
function omnirouteWindow(window: string): string {
  const named = OMNIROUTE_WINDOW_LABELS[window]
  if (named !== undefined) return named
  const label = window.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** A reset instant from either an ISO string or an epoch-millisecond number. */
function resetMsOf(value: unknown): number | undefined {
  return isoToMs(value) ?? numberOf(value)
}

/**
 * Parse OmniRoute's per-connection usage answers, one payload per connection
 * it was asked about (a connection that failed arrives `undefined` and is
 * skipped).
 *
 * OmniRoute routes to accounts it holds, so it publishes no figure for the
 * route itself: every upstream connection carries its own plan and its own
 * windows. The reading is therefore the fullest window across them, and every
 * line names the plan it belongs to.
 * @param payloads - one `/api/usage/<id>` body per asked connection.
 * @returns the reading, or `null` when no connection reported a meter.
 */
function parseOmniRouteUsage(payloads: ProbePayloads): ProbeReading | null {
  const lines: string[] = []
  const percents: number[] = []
  let money: string | undefined
  for (const payload of payloads) {
    const usage = record(payload)
    if (usage === undefined) continue
    const plan = stringOf(usage['plan']) ?? 'OmniRoute'
    const quotas = record(usage['quotas'])
    if (quotas !== undefined) {
      for (const [window, raw] of Object.entries(quotas)) {
        const meter = record(raw)
        if (meter === undefined) continue
        const remaining = numberOf(meter['remaining'])
        const total = numberOf(meter['total'])
        const used = numberOf(meter['used'])
        const left = numberOf(meter['remainingPercentage'])
        // A ceiling is what makes a percentage mean anything: DeepSeek's
        // balance reports `remainingPercentage: 100` over a `total` of zero,
        // which is a wallet, and an `unlimited` meter has no ceiling at all.
        const ceiling = meter['unlimited'] === true ? undefined : total
        const capped = ceiling !== undefined && ceiling > 0
        let percent = capped && left !== undefined ? percentOf(100 - left) : undefined
        if (percent === undefined && capped && used !== undefined) {
          percent = percentOf(100 * used / ceiling)
        }
        const reset = resetSuffixFrom(resetMsOf(meter['resetAt']))
        if (percent === undefined) {
          // A wallet, not a meter: DeepSeek's balance reports a spendable
          // amount with no ceiling, so money is the only honest figure.
          if (remaining === undefined) continue
          const shown = formatMoney(remaining, stringOf(meter['currency']) ?? 'USD')
          money ??= shown
          lines.push(`${plan} · ${omnirouteWindow(window)} ${shown} left${reset}`)
          continue
        }
        percents.push(percent)
        lines.push(`${plan} · ${omnirouteWindow(window)} ${String(Math.round(percent))}% used${reset}`)
      }
    }
    if (usage['limitReached'] === true) lines.push(`${plan} limit reached`)
  }
  if (lines.length === 0) return null
  const headline = percents.length === 0 ? undefined : Math.max(...percents)
  const shown = lines.slice(0, MAX_OMNIROUTE_LINES)
  if (shown.length < lines.length) shown.push(`+${String(lines.length - shown.length)} more`)
  return {
    text: headline === undefined ? money ?? 'OmniRoute' : `OmniRoute ${remainingOf(headline)}%`,
    ...headline === undefined ? {} : { remaining: remainingOf(headline) },
    lines: shown,
  }
}

/** GET one JSON body, or `undefined` when the request fails or is refused. */
async function getJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

/**
 * OmniRoute quota probe: it publishes per connection, not per route, so the
 * listing is read first and one usage request is built per listed connection.
 * A connection that is switched off or hides its quota is skipped rather than
 * asked, and one that fails simply contributes no line.
 * @param origin - the route's configured origin, without its `/v1` path.
 * @returns the probe.
 */
function omnirouteProbe(origin: string): Probe {
  return {
    kind: 'quota',
    envNames: ['OMNIROUTE_API_KEY'],
    requests: async ({ key, timeoutMs }) => {
      const headers = { authorization: `Bearer ${key}`, accept: 'application/json' }
      const listing = await getJson(`${origin}${OMNIROUTE_CONNECTIONS_PATH}`, headers, timeoutMs)
      const connections = record(listing)?.['connections']
      if (!Array.isArray(connections)) return []
      const requests: LocalRequest[] = []
      for (const entry of connections) {
        const connection = record(entry)
        if (connection === undefined) continue
        if (connection['quotaVisible'] === false || connection['isActive'] === false) continue
        const id = stringOf(connection['id'])
        if (id === undefined) continue
        requests.push({ url: `${origin}${OMNIROUTE_USAGE_PATH}${encodeURIComponent(id)}`, headers })
      }
      return requests
    },
    parse: parseOmniRouteUsage,
  }
}

/** A percentage clamped to the range a meter can report. */
function percentOf(value: unknown): number | undefined {
  const parsed = numberOf(value)
  return parsed === undefined ? undefined : Math.min(100, Math.max(0, parsed))
}

/** `, resets <local time>` for an epoch-millisecond reset, or nothing. */
function resetSuffixFrom(ms: number | undefined): string {
  return ms === undefined ? '' : `, resets ${new Date(ms).toLocaleString()}`
}

/** A cents amount as a dollar figure, or nothing. */
function centsOf(value: unknown): string | undefined {
  const parsed = numberOf(value)
  return parsed === undefined ? undefined : formatMoney(parsed / 100, 'USD')
}

/** One plan window as the tooltip spells it. */
function windowLine(label: string, percent: number, resetMs?: number): string {
  return `${label} ${String(Math.round(percent))}% used${resetSuffixFrom(resetMs)}`
}

/** The fullest window of a meter set, which is what the chip shows. */
function fullest(windows: readonly { percent: number }[]): number | undefined {
  return windows.length === 0 ? undefined : Math.max(...windows.map(window => window.percent))
}

/** Parse Claude Code's `/api/oauth/usage` payload: session, weekly, extras. */
function parseClaudeUsage(payload: unknown): ProbeReading | null {
  const data = record(payload)
  if (data === undefined) return null
  const windows: { label: string; percent: number; resetMs?: number }[] = []
  let session: { percent: number; resetMs?: number } | undefined

  const limits = data['limits']
  if (Array.isArray(limits) && limits.length > 0) {
    for (const entry of limits) {
      const limit = record(entry)
      if (limit === undefined) continue
      const percent = percentOf(limit['percent'])
      if (percent === undefined) continue
      const kind = stringOf(limit['kind']) ?? ''
      const group = stringOf(limit['group']) ?? ''
      const resetMs = isoToMs(limit['resets_at'])
      if (kind === 'session' || group === 'session') {
        session = { percent, ...resetMs === undefined ? {} : { resetMs } }
        continue
      }
      const scope = record(limit['scope'])
      const model = record(scope?.['model'])
      const label = stringOf(scope?.['surface'])
        ?? stringOf(model?.['display_name'])
        ?? 'All models'
      windows.push({ label, percent, ...resetMs === undefined ? {} : { resetMs } })
    }
  } else {
    for (const [key, label] of [
      ['seven_day', 'All models'],
      ['seven_day_opus', 'Opus'],
      ['seven_day_sonnet', 'Sonnet'],
      ['seven_day_cowork', 'Cowork'],
    ] as const) {
      const block = record(data[key])
      if (block === undefined) continue
      const percent = percentOf(block['utilization'])
      if (percent === undefined) continue
      const resetMs = isoToMs(block['resets_at'])
      windows.push({ label, percent, ...resetMs === undefined ? {} : { resetMs } })
    }
    const five = record(data['five_hour'])
    const percent = percentOf(five?.['utilization'])
    if (percent !== undefined) {
      const resetMs = isoToMs(five?.['resets_at'])
      session = { percent, ...resetMs === undefined ? {} : { resetMs } }
    }
  }

  // The chip answers "how much is left", so the fullest meter names it: a
  // weekly cap at 100% is the whole story even when the 5-hour session is idle.
  const headline = fullest([
    ...session === undefined ? [] : [{ percent: session.percent }],
    ...windows,
  ])
  if (headline === undefined) return null
  const lines: string[] = []
  if (session !== undefined) {
    lines.push(`Session ${String(Math.round(session.percent))}% used${resetSuffixFrom(session.resetMs)}`)
  }
  for (const window of windows) lines.push(windowLine(window.label, window.percent, window.resetMs))

  const extra = record(data['extra_usage'])
  if (extra?.['is_enabled'] === true) {
    const used = centsOf(extra['used_credits'])
    const limit = centsOf(extra['monthly_limit'])
    lines.push(limit === undefined
      ? `Extra usage enabled${used === undefined ? '' : `, ${used} used`}`
      : `Extra usage ${used ?? '$0.00'} of ${limit}`)
  }
  return { text: `Claude ${remainingOf(headline)}%`, remaining: remainingOf(headline), lines }
}

/** Codex window label, from the window's own duration. */
function codexWindowLabel(seconds: number | undefined, name: string): string {
  if (seconds === undefined || seconds === 0) return name.replaceAll('_', ' ')
  if (seconds <= 6 * 3_600) return 'Current session'
  if (seconds <= 2 * 86_400) return `${String(Math.max(1, Math.round(seconds / 3_600)))}-hour`
  if (seconds >= 6 * 86_400 && seconds <= 8 * 86_400) return 'Weekly'
  if (seconds >= 28 * 86_400 && seconds <= 32 * 86_400) return 'Monthly'
  return `${String(Math.max(1, Math.round(seconds / 86_400)))}-day`
}

/** One Codex rate-limit window, or `undefined` when it reports no percentage. */
function codexWindow(block: unknown, name: string): { label: string; percent: number; resetMs?: number } | undefined {
  const window = record(block)
  if (window === undefined) return undefined
  const percent = percentOf(window['used_percent'])
  if (percent === undefined) return undefined
  const seconds = numberOf(window['limit_window_seconds'])
  const resetAt = numberOf(window['reset_at'])
  const resetAfter = numberOf(window['reset_after_seconds'])
  const resetMs = resetAt !== undefined
    ? resetAt * 1_000
    : resetAfter === undefined ? undefined : Date.now() + resetAfter * 1_000
  return {
    label: codexWindowLabel(seconds, name),
    percent,
    ...resetMs === undefined ? {} : { resetMs },
  }
}

/** Parse Codex's `/backend-api/wham/usage` payload: plan, windows, credits. */
function parseCodexUsage(payload: unknown): ProbeReading | null {
  const data = record(payload)
  if (data === undefined) return null
  const plan = stringOf(data['plan_type'])?.replaceAll('_', ' ') ?? 'Codex'
  const rate = record(data['rate_limit']) ?? {}
  const windows: { label: string; percent: number; resetMs?: number }[] = []
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const window = codexWindow(rate[key], key)
    if (window !== undefined) windows.push(window)
  }
  const review = record(data['code_review_rate_limit'])
  if (review !== undefined) {
    if (review['primary_window'] !== undefined || review['secondary_window'] !== undefined) {
      for (const key of ['primary_window', 'secondary_window'] as const) {
        const window = codexWindow(review[key], `code_review_${key}`)
        if (window !== undefined) windows.push({ ...window, label: `Code review · ${window.label}` })
      }
    } else {
      const window = codexWindow(review, 'code_review')
      if (window !== undefined) windows.push({ label: 'Code review', percent: window.percent, ...window.resetMs === undefined ? {} : { resetMs: window.resetMs } })
    }
  }
  const credits = record(data['credits']) ?? {}
  const balance = numberOf(credits['balance'])
  const hasCredits = credits['has_credits'] === true && balance !== undefined
  const headline = fullest(windows)
  if (headline === undefined && !hasCredits) return null
  const lines = [`Plan ${plan.replace(/\b\w/g, letter => letter.toUpperCase())}`]
  for (const window of windows) lines.push(windowLine(window.label, window.percent, window.resetMs))
  if (hasCredits) lines.push(`Credits ${String(balance)}`)
  if (rate['limit_reached'] === true) lines.push('Limit reached')
  return {
    text: headline === undefined ? `${String(balance)} credits` : `Codex ${remainingOf(headline)}%`,
    ...headline === undefined ? {} : { remaining: remainingOf(headline) },
    lines,
  }
}

/** One Grok billing config as a period, or `undefined` when it reports none. */
function grokPeriod(payload: unknown): { label: string; percent?: number; used?: number; limit?: number; resetMs?: number } | undefined {
  const body = record(payload)
  if (body === undefined) return undefined
  const config = record(body['config']) ?? body
  const period = record(config['currentPeriod']) ?? {}
  const type = stringOf(period['type']) ?? ''
  let label = type.includes('WEEKLY') ? 'Weekly' : type.includes('MONTHLY') ? 'Monthly' : 'Usage'
  const resetMs = isoToMs(period['end']) ?? isoToMs(config['billingPeriodEnd']) ?? isoToMs(config['billing_period_end'])

  const creditPercent = numberOf(config['creditUsagePercent'])
  const creditsShaped = config['creditUsagePercent'] !== undefined
    || config['currentPeriod'] !== undefined
    || config['isUnifiedBillingUser'] === true
  if (creditsShaped) {
    return { label, percent: percentOf(creditPercent ?? 0), ...resetMs === undefined ? {} : { resetMs } }
  }
  const used = numberOf(config['used'])
  const limit = numberOf(config['monthlyLimit']) ?? numberOf(config['monthly_limit'])
  const percent = used !== undefined && limit !== undefined && limit !== 0 ? percentOf(100 * used / limit) : undefined
  if (label === 'Usage') label = 'Monthly'
  return {
    label,
    ...percent === undefined ? {} : { percent },
    ...used === undefined ? {} : { used },
    ...limit === undefined ? {} : { limit },
    ...resetMs === undefined ? {} : { resetMs },
  }
}

/** Parse Grok's two billing payloads: weekly credits, then monthly spend. */
function parseGrokBilling(payloads: ProbePayloads): ProbeReading | null {
  const seen = new Set<string>()
  const periods: { label: string; line: string; percent?: number }[] = []
  for (const payload of payloads) {
    const period = grokPeriod(payload)
    if (period === undefined) continue
    // A meter with no figure at all is not a meter: it would only add a row
    // that says nothing.
    if (period.percent === undefined && period.used === undefined) continue
    const key = `${period.label}/${String(period.resetMs ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    const money = period.used === undefined
      ? undefined
      : `${centsOf(period.used) ?? ''}${period.limit === undefined ? '' : ` of ${centsOf(period.limit) ?? ''}`}`
    // A spend meter reads better as money; a credit meter only has a percentage.
    const line = money !== undefined
      ? `${period.label} ${money}${resetSuffixFrom(period.resetMs)}`
      : period.percent === undefined
        ? `${period.label} usage${resetSuffixFrom(period.resetMs)}`
        : windowLine(period.label, period.percent, period.resetMs)
    periods.push({
      label: period.label,
      line,
      ...period.percent === undefined ? {} : { percent: period.percent },
    })
  }
  if (periods.length === 0) return null
  const percentages = periods.filter(period => period.percent !== undefined) as { percent: number }[]
  const headline = fullest(percentages)
  return {
    text: headline === undefined ? 'Grok usage' : `Grok ${remainingOf(headline)}%`,
    ...headline === undefined ? {} : { remaining: remainingOf(headline) },
    lines: periods.map(period => period.line),
  }
}

/** Cursor's plan name, from the membership string the API reports. */
function cursorPlanLabel(membership: string | undefined): string {
  const key = (membership ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  const names: Readonly<Record<string, string>> = {
    free: 'Free',
    hobby: 'Hobby',
    pro: 'Pro',
    pro_plus: 'Pro+',
    proplus: 'Pro+',
    ultra: 'Ultra',
    business: 'Business',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
  }
  return names[key] ?? (key === '' ? 'Cursor' : key.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()))
}

/** One Cursor meter as a window, or `undefined` when it carries no figure. */
function cursorMeter(block: unknown, label: string, resetMs: number | undefined): { label: string; percent?: number; line: string; resetMs?: number } | undefined {
  const meter = record(block)
  if (meter === undefined || meter['enabled'] === false) return undefined
  const used = numberOf(meter['used'])
  const limit = numberOf(meter['limit'])
  let percent = percentOf(meter['totalPercentUsed'])
  if (percent === undefined && used !== undefined && limit !== undefined && limit !== 0) {
    percent = percentOf(100 * used / limit)
  }
  if (percent === undefined && used === undefined && limit === undefined) return undefined
  const detail = used === undefined
    ? undefined
    : `${String(used)}${limit === undefined ? '' : ` of ${String(limit)}`}`
  return {
    label,
    ...percent === undefined ? {} : { percent },
    ...resetMs === undefined ? {} : { resetMs },
    line: percent === undefined
      ? `${label} ${detail ?? 'usage'}${resetSuffixFrom(resetMs)}`
      : windowLine(label, percent, resetMs),
  }
}

/** Parse Cursor's `/api/usage-summary` payload: plan, included, on-demand. */
function parseCursorSummary(payload: unknown): ProbeReading | null {
  const data = record(payload)
  if (data === undefined) return null
  const plan = cursorPlanLabel(stringOf(data['membershipType']))
  const cycleEnd = isoToMs(data['billingCycleEnd'])
  const meters: { label: string; percent?: number; line: string }[] = []
  const individual = record(data['individualUsage']) ?? {}
  if (data['isUnlimited'] === true) {
    return { text: 'Cursor unlimited', lines: [`Plan ${plan}`] }
  }
  const included = cursorMeter(individual['plan'], 'Included', cycleEnd)
    ?? cursorMeter(individual['overall'], 'Included', cycleEnd)
  if (included !== undefined) meters.push(included)
  const onDemand = cursorMeter(individual['onDemand'], 'On-demand', cycleEnd)
  if (onDemand !== undefined) meters.push(onDemand)
  if (meters.length === 0) return null
  const percentages = meters.filter(meter => meter.percent !== undefined) as { percent: number }[]
  const headline = fullest(percentages)
  return {
    text: headline === undefined ? 'Cursor usage' : `Cursor ${remainingOf(headline)}%`,
    ...headline === undefined ? {} : { remaining: remainingOf(headline) },
    lines: [`Plan ${plan}`, ...meters.map(meter => meter.line)],
  }
}

/** DeepSeek balance probe, against the configured origin or the public API. */
function deepSeekProbe(origin: string): Probe {
  return {
    kind: 'balance',
    url: `${origin}/user/balance`,
    envNames: ['DEEPSEEK_API_KEY'],
    parse: payloads => parseDeepSeekBalance(payloads[0]),
  }
}

/** OpenRouter credits probe. */
function openRouterProbe(origin: string): Probe {
  return {
    kind: 'balance',
    url: `${origin}/api/v1/credits`,
    envNames: ['OPENROUTER_API_KEY'],
    parse: payloads => parseOpenRouterCredits(payloads[0]),
  }
}

/** z.ai / BigModel Coding Plan quota probe. */
function zaiProbe(origin: string): Probe {
  return {
    kind: 'quota',
    url: `${origin}/api/monitor/usage/quota/limit`,
    envNames: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'BIGMODEL_API_KEY', 'ZHIPU_API_KEY'],
    parse: payloads => parseZaiQuota(payloads[0]),
  }
}

/** LiteLLM key budget probe: the fallback shape for a proxy deployment. */
function liteLlmProbe(origin: string): Probe {
  return {
    kind: 'balance',
    url: `${origin}/key/info`,
    envNames: [],
    parse: payloads => parseLiteLlmKeyInfo(payloads[0]),
  }
}

/** Claude Code subscription probe: the plan's own usage meter. */
function claudeProbe(): Probe {
  return { kind: 'quota', local: 'claude', parse: payloads => parseClaudeUsage(payloads[0]) }
}

/** Codex (ChatGPT) subscription probe. */
function codexProbe(): Probe {
  return { kind: 'quota', local: 'codex', parse: payloads => parseCodexUsage(payloads[0]) }
}

/** Grok subscription probe: two billing meters in one reading. */
function grokProbe(): Probe {
  return { kind: 'quota', local: 'grok', parse: parseGrokBilling }
}

/** Cursor subscription probe. */
function cursorProbe(): Probe {
  return { kind: 'quota', local: 'cursor', parse: payloads => parseCursorSummary(payloads[0]) }
}

/**
 * Whether a route id names a vendor whose own endpoint this plugin knows, so a
 * route that matches no host must not be handed to the aggregator fallback.
 * @param id - lowercased provider route id.
 * @returns true when the id names a known vendor.
 */
function namesVendor(id: string): boolean {
  return id.startsWith('deepseek') || id.includes('openrouter') || id.includes('litellm')
    || id.includes('zai') || id.includes('zhipu') || id.includes('bigmodel') || id.includes('glm')
    || id.includes('claude') || id.includes('anthropic') || id.includes('codex')
    || id.includes('chatgpt') || id.includes('grok') || id.includes('xai') || id.includes('cursor')
}

/**
 * Resolve the probe answering for one provider route.
 *
 * A configured base URL decides alone when it names a known host, because the
 * host is the endpoint that actually answers. The provider id only decides
 * when no base URL is configured (the route relies on its library's own
 * default), so a route named after a provider but pointed somewhere else — a
 * local vLLM serving DeepSeek weights, or Vertex-hosted Claude, say — is never
 * read from that provider's own subscription credential.
 *
 * The subscription probes come first among the id-based rules because their
 * host is the vendor itself, not a reseller: a route called `anthropic` with no
 * base URL is Claude Code's plan meter, while `google-vertex-anthropic` carries
 * a googleapis.com host and resolves nothing.
 *
 * A route that names no vendor and still has a base URL gets the LiteLLM
 * key-budget probe, which is how a proxy deployment is recognized at all.
 * @param providerId - route id as the model picker names it, e.g. `deepseek-official`.
 * @param baseURL - the route's configured base URL, when it has one.
 * @returns the probe, or `undefined` when no balance or quota route is known.
 */
export function resolveProbe(providerId: string, baseURL?: string): Probe | undefined {
  const id = providerId.toLowerCase()
  const host = hostOf(baseURL)
  const unset = host === ''
  if (id.includes('litellm')) return liteLlmProbe(originOf(baseURL, 'http://localhost:4000'))
  if (host.endsWith('api.anthropic.com') || (unset && (id.includes('claude') || id.includes('anthropic')))) {
    return claudeProbe()
  }
  if (host.endsWith('chatgpt.com') || (unset && (id.includes('codex') || id.includes('chatgpt')))) {
    return codexProbe()
  }
  if (host.endsWith('cli-chat-proxy.grok.com') || host.endsWith('api.x.ai')
    || (unset && (id.includes('grok') || id.includes('xai')))) {
    return grokProbe()
  }
  if (host.endsWith('cursor.com') || (unset && id.includes('cursor'))) return cursorProbe()
  if (host.endsWith('api.deepseek.com') || (unset && id.startsWith('deepseek'))) {
    return deepSeekProbe(originOf(baseURL, 'https://api.deepseek.com'))
  }
  if (host.endsWith('openrouter.ai') || (unset && id.includes('openrouter'))) {
    return openRouterProbe(originOf(baseURL, 'https://openrouter.ai'))
  }
  const bigmodel = host.endsWith('open.bigmodel.cn')
  if (bigmodel || host.endsWith('api.z.ai') || (unset && ZAI_IDS.has(id))) {
    return zaiProbe(originOf(baseURL, bigmodel ? 'https://open.bigmodel.cn' : 'https://api.z.ai'))
  }
  // OmniRoute fronts the accounts it holds, so its own API — not the vendor's —
  // is where a figure lives, and it answers per upstream connection. The route
  // is recognised by its id because the host is whatever machine runs it.
  if (id.includes('omniroute')) return omnirouteProbe(originOf(baseURL, 'http://localhost:20128'))
  // An aggregator route: named after a model, a plan, or the proxy itself. The
  // one per-route figure such a host may carry is LiteLLM's key budget, and a
  // host without that route answers 404, which renders as no chip.
  if (baseURL === undefined || unset || namesVendor(id)) return undefined
  return liteLlmProbe(originOf(baseURL, baseURL))
}
