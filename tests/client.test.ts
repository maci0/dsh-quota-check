/**
 * Browser half: the bundle is evaluated the way the client module system loads
 * it (a lazy-CJS factory on `window.__ModuleLoader__`), registered against a
 * fake slot registry, and rendered with a minimal React stub. These cases
 * therefore exercise the shipped `lib/client.js`, not a copy of its logic.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** One rendered element. */
interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** Minimal React runtime: one hook array reused across explicit render passes. */
function createHookRuntime(): {
  react: Record<string, unknown>
  beginRender: () => void
  takeEffects: () => (() => unknown)[]
} {
  const states: unknown[] = []
  let index = 0
  let effects: (() => unknown)[] = []
  return {
    react: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
        type,
        props: props ?? {},
        children: children.flat(),
      }),
      useState: (initial: unknown): [unknown, (next: unknown) => void] => {
        const slot = index++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        return [states[slot], (next: unknown) => {
          states[slot] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[slot]) : next
        }]
      },
      useEffect: (callback: () => unknown): void => { effects.push(callback) },
    },
    beginRender: (): void => { index = 0; effects = [] },
    takeEffects: (): (() => unknown)[] => {
      const taken = effects
      effects = []
      return taken
    },
  }
}

/** Load the bundle, apply it, and return the component it registered. */
function mount(): {
  slot: string
  entry: Record<string, unknown>
  component: (props: Record<string, unknown>) => Element | null
  runtime: ReturnType<typeof createHookRuntime>
} {
  const runtime = createHookRuntime()
  const registrations: { slot: string; entry: Record<string, unknown>; component: (props: Record<string, unknown>) => Element | null }[] = []
  const ctx = {
    effect: (callback: () => unknown): unknown => callback(),
    locale: {
      bind: () => (key: string) => key,
      register: (): void => {},
    },
    // The Plugins card binds this namespace; these cases exercise the chip, and
    // the card's own contract is covered by tests/config-card.test.ts.
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }),
        subscribe: () => () => {},
        mutate: async () => false,
        set: async () => false,
        unset: async () => false,
      }),
    },
    slots: {
      inject: (slot: string, callback: () => unknown): void => {
        // A placeholder per injected slot; the `register` that follows fills the
        // last one in. The chip is registered first, so `registrations[0]` is it.
        registrations.push({ slot, entry: {}, component: () => null })
        callback()
      },
      register: (entry: Record<string, unknown>, component: (props: Record<string, unknown>) => Element | null): (() => void) => {
        const last = registrations[registrations.length - 1]
        if (last !== undefined) {
          last.entry = entry
          last.component = component
        }
        return () => {}
      },
    },
  }
  let loaded: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
  const appended: { textContent: string }[] = []
  const windowStub = { __ModuleLoader__: { load: (registration: typeof loaded): void => { loaded = registration } } }
  const documentStub = {
    createElement: (): { textContent: string } => ({ textContent: '' }),
    head: { append: (element: { textContent: string }): void => { appended.push(element) } },
  }
  const requireFn = (id: string): unknown => {
    assert.equal(id, 'react', `the bundle may only require react, got ${id}`)
    return runtime.react
  }
  new Function('window', 'require', 'document', readFileSync(bundlePath, 'utf8'))(windowStub, requireFn, documentStub)
  assert.ok(loaded, 'the bundle registered itself on window.__ModuleLoader__')
  assert.equal(loaded.id, 'dsh-quota-check')
  const exported = loaded.factory(requireFn)
  // The chip must land under the model selector: pushed right by the auto left
  // margin, then pulled back by the composer card's own inset plus the send
  // control, and the pill radius must pair with the corner-shape rule.
  const sheet = appended[0]?.textContent ?? ''
  assert.match(sheet, /\.qc-chip\{--qc-control-inset:46px;order:1;margin-left:auto;margin-right:calc\(max\(0px,\(100% - var\(--dsh-composer-card-max-width\)\)\/2\) \+ var\(--qc-control-inset\)\)/)
  assert.match(sheet, /border-radius:999px;corner-shape:round/)
  assert.deepEqual(exported['inject'], ['slots', 'configForms', 'locale'])
  ;(exported['apply'] as (ctx: unknown) => void)(ctx)
  const registration = registrations[0]
  assert.ok(registration)
  return { ...registration, runtime }
}

/** Replace global fetch for one case; returns the URLs it saw and a restore. */
function stubFetch(report: unknown): { urls: string[]; restore: () => void } {
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    urls.push(String(url))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(report) })
  }) as typeof globalThis.fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}

/** Render once, run this pass's effects, let the fetch settle, render again, then clean up. */
async function settle(
  registration: { component: (props: Record<string, unknown>) => Element | null; runtime: ReturnType<typeof createHookRuntime> },
  props: Record<string, unknown>,
): Promise<Element | null> {
  const cleanups: (() => void)[] = []
  registration.runtime.beginRender()
  registration.component(props)
  for (const effect of registration.runtime.takeEffects()) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  }
  await new Promise(resolve => { setTimeout(resolve, 0) })
  registration.runtime.beginRender()
  const element = registration.component(props)
  for (const cleanup of cleanups) cleanup()
  return element
}

test('the chip registers into the composer statusbar and draws the host reading', async () => {
  const registration = mount()
  assert.equal(registration.slot, 'conversation.composer.dock')
  assert.equal(registration.entry['name'], 'conversation.composer.dock')
  assert.equal(registration.entry['id'], 'quota-check')
  const stub = stubFetch({
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    status: 'ok',
    text: '¥110.00',
    lines: ['Balance ¥110.00'],
  })
  try {
    const element = await settle(registration, {
      useProjection: (key: string) => (key === 'modelSelection' ? { next: { provider: 'deepseek-official' }, lastUsed: null } : undefined),
    })
    assert.equal(element?.type, 'button')
    assert.deepEqual(element?.children, ['¥110.00'])
    assert.equal(element?.props['title'], 'DeepSeek\nBalance ¥110.00')
    assert.equal(stub.urls.length, 1)
    assert.equal(stub.urls[0], '/quota-check?provider=deepseek-official')
  } finally {
    stub.restore()
  }
})

test('nothing renders while the provider publishes no figure', async () => {
  const registration = mount()
  const stub = stubFetch({ provider: 'vllm-local', displayName: 'vllm-local', status: 'unsupported' })
  try {
    const element = await settle(registration, {
      useProjection: (key: string) => (key === 'modelSelection' ? { next: { provider: 'vllm-local' }, lastUsed: null } : undefined),
    })
    assert.equal(element, null)
  } finally {
    stub.restore()
  }
})

test('nothing renders and nothing is asked while no model is selected', async () => {
  const registration = mount()
  const stub = stubFetch({ status: 'ok', text: '$1' })
  try {
    const element = await settle(registration, { useProjection: () => undefined })
    assert.equal(element, null)
    assert.equal(stub.urls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a fallback to the last used provider still draws a figure', async () => {
  const registration = mount()
  const stub = stubFetch({ displayName: 'OpenRouter', status: 'ok', text: '$12.34', lines: ['Remaining $12.34'] })
  try {
    const element = await settle(registration, {
      useProjection: (key: string) => (key === 'modelSelection' ? { next: null, lastUsed: { provider: 'openrouter' } } : undefined),
    })
    assert.equal(element?.children[0], '$12.34')
    assert.equal(stub.urls[0], '/quota-check?provider=openrouter')
  } finally {
    stub.restore()
  }
})
