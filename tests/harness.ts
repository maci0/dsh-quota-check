/**
 * Shared fixture for the host-half specs: one fake Cordis context, one request
 * driver, and the fetch stub the route cases share. `plugin.test.ts` drives the
 * route through it and `perf.test.ts` counts work through the same mount, so
 * the fake context is described once for both.
 */

import assert from 'node:assert/strict'
import { apply, ROUTE } from '../src/index.ts'
import type { Disposable, HostContext, SettingsDescriptorLike, WebRouteLike } from '../src/host.ts'

/** One captured response. */
export interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** Services a case may mount; absent keys read as "not mounted". */
export interface Services {
  llm?: unknown
  settings?: { describe(): readonly SettingsDescriptorLike[] }
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  connection?: { requestRejection(request: { headers: object | undefined }): 401 | 403 | undefined }
}

/** Mount the plugin over a fake context and return its registered route. */
export function mount(services: Services, config?: { cacheSeconds?: number }): { route: WebRouteLike } {
  const routes: WebRouteLike[] = []
  const ctx = {
    inject: (): void => {},
    effect: (callback: () => Disposable | void): void => { callback() },
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
  return { route }
}

/** Run one request through the route. */
export async function request(route: WebRouteLike, url: string, method = 'GET', headers: object = {}): Promise<Captured> {
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
export function stubFetch(payload: unknown, options?: { status?: number }): { calls: { url: string; headers: Record<string, string> }[]; restore: () => void } {
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
