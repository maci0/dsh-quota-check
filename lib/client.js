/**
 * dsh-quota-check — browser half: the quota chip in the composer statusbar,
 * and the Quota check card on the Plugins page.
 *
 * It reads the session's model-selection projection for the provider in use,
 * asks the host half's `/quota-check` route for that provider's figure, and
 * renders one compact chip in `conversation.composer.dock` — the statusbar row
 * under the composer card, flush right so it sits directly beneath the model
 * selector. Nothing renders while a session has no selection, while the
 * provider has no known balance or quota route, or while a lookup is failing:
 * the statusbar never grows a "no data" row.
 *
 * The provider key never reaches the browser. The host resolves the
 * credential, calls the provider, and returns the formatted text and its
 * tooltip lines; this half only draws them. A click forces a fresh read (the
 * host serves cached readings for a minute otherwise).
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`, and that is the whole format — an out-of-tree
 * plugin can author it directly instead of reproducing the repository's tsdown
 * client preset. `react` is provided by the module system; nothing else is
 * required here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-quota-check',

  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** The host half's one route; same origin, so the session cookie rides along. */
    const ROUTE = '/quota-check'

    /** Re-read cadence used until the host reports the configured one. */
    const FALLBACK_REFRESH_MS = 5 * 60 * 1000

    /** Every class is `qc-`-prefixed: the sheet lands in the page's own document. */
    const CSS = [
      // The dock spans the whole composer column while the card is capped and
      // centered inside it, so the chip is pushed right and then pulled back by
      // the card's own inset: `max(0, (100% - cardMaxWidth) / 2)` is the gap
      // between the dock edge and the card edge (`0` when the card fills the
      // column, which the `100%` branch of the token already accounts for).
      // `--qc-control-inset` then clears the send control — the 34px primary
      // button plus the trailing row's 12px gap — so the figure lands under the
      // model selector instead of under the send button.
      '.qc-chip{--qc-control-inset:46px;order:1;margin-left:auto;margin-right:calc(max(0px,(100% - var(--dsh-composer-card-max-width))/2) + var(--qc-control-inset));appearance:none;display:inline-flex;align-items:center;font:inherit;font-size:11px;line-height:1.5;padding:0 6px;border:0;border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-tertiary);background:none;cursor:pointer;white-space:nowrap}',
      '.qc-chip:hover{color:var(--dsw-alias-label-secondary)}',
      // Countdown color: green when plenty is left, red when it is nearly gone.
      '.qc-chip[data-level="ok"]{color:#3fb950}',
      '.qc-chip[data-level="warn"]{color:#d29922}',
      '.qc-chip[data-level="low"]{color:#db6d28}',
      '.qc-chip[data-level="crit"]{color:#f85149}',
      // Plugins-page card. Classes stay `qc-`-prefixed: one sheet, one owner.
      '.qc-page{display:flex;flex-direction:column;gap:12px}',
      '.qc-field{display:flex;flex-direction:column;gap:4px}',
      '.qc-label{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.qc-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.qc-input{font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;width:100%;box-sizing:border-box}',
      '.qc-input:disabled{cursor:default;opacity:.5}',
      '.qc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.qc-button{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.qc-button:disabled{cursor:default;opacity:.5}',
      '.qc-button-quiet{padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.qc-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.qc-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    // Appended while the factory materializes: the module system claims the tag
    // for this package and disposes it on unload. Guarded because the node unit
    // tests evaluate this file without a DOM.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /**
     * The provider the session is currently using, from the durable selection
     * projection. `next` is the pending pick and wins over the last request's.
     * @param useProjection - session-scope projection hook from the slot kit.
     * @returns the provider route id, or undefined while nothing is selected.
     */
    function providerOf(useProjection) {
      const selection = useProjection('modelSelection')
      const current = selection === undefined || selection === null
        ? undefined
        : selection.next ?? selection.lastUsed
      return current === undefined || current === null ? undefined : current.provider
    }

    /**
     * Build the statusbar chip.
     * @returns the component the composer dock renders.
     */
    function createChip() {
      return function QuotaChip(props) {
        const provider = providerOf(props.useProjection)
        const [report, setReport] = React.useState(null)
        // A click bumps this, which re-runs the effect with a forced refresh.
        const [nonce, setNonce] = React.useState(0)

        React.useEffect(() => {
          if (provider === undefined) {
            setReport(null)
            return undefined
          }
          const controller = new AbortController()
          let timer
          // The host owns the cadence: it reports the configured interval, so a
          // deployment changes it from cordis.yml and the browser follows.
          const schedule = (next) => {
            const wait = next !== null && Number.isFinite(next.refreshMs)
              ? Math.max(10_000, next.refreshMs)
              : FALLBACK_REFRESH_MS
            timer = setTimeout(() => { load(false) }, wait)
          }
          const load = (force) => {
            const url = `${ROUTE}?provider=${encodeURIComponent(provider)}${force ? '&refresh=1' : ''}`
            fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
              .then(response => response.ok ? response.json() : null)
              .then(next => {
                if (controller.signal.aborted) return
                setReport(next)
                schedule(next)
              })
              .catch(() => {
                if (controller.signal.aborted) return
                setReport(null)
                schedule(null)
              })
          }
          load(nonce > 0)
          return () => {
            controller.abort()
            clearTimeout(timer)
          }
        }, [provider, nonce])

        if (report === null || report.status !== 'ok') return null
        const title = [report.displayName, ...(report.lines ?? [])].join('\n')
        // Green ≥50% left, yellow ≥25%, orange ≥10%, red below. A reading
        // without a percentage (a money balance) keeps the default color.
        const remaining = typeof report.remaining === 'number' ? report.remaining : undefined
        const level = remaining === undefined ? undefined
          : remaining >= 50 ? 'ok'
          : remaining >= 25 ? 'warn'
          : remaining >= 10 ? 'low'
          : 'crit'
        return React.createElement(
          'button',
          {
            type: 'button',
            className: 'qc-chip',
            title,
            'aria-label': title,
            ...(level === undefined ? {} : { 'data-level': level }),
            onClick: () => { setNonce(current => current + 1) },
          },
          report.text,
        )
      }
    }


    /** Settings namespace shared with the host half; also this card's slot key. */
    const NAMESPACE = 'quota-check'

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'quota-check'

    /** Plugin version, shown in the card footer. Kept in lockstep with package.json. */
    const VERSION = '0.7.4'

    /**
     * Every editable row field, in display order, with the bounds the row schema
     * enforces. The card checks them before the write so a typo is answered
     * where it was typed instead of by a refused save.
     */
    const FIELDS = [
      { key: 'cacheSeconds', label: 'labelCacheSeconds', hint: 'hintCacheSeconds', min: 0, max: 3600 },
      { key: 'timeoutMs', label: 'labelTimeoutMs', hint: 'hintTimeoutMs', min: 1, max: 60_000 },
      { key: 'refreshSeconds', label: 'labelRefreshSeconds', hint: 'hintRefreshSeconds', min: 10, max: 3600 },
    ]

    const en = {
      title: 'Quota check',
      summary: 'Quota chip in the composer statusbar — {refreshSeconds}s refresh.',
      summaryEmpty: 'Quota chip in the composer statusbar.',
      labelCacheSeconds: 'Cache seconds',
      labelTimeoutMs: 'Request deadline (ms)',
      labelRefreshSeconds: 'Browser refresh (seconds)',
      hintCacheSeconds: 'How long a reading is served before the provider is asked again. 0 asks every time.',
      hintTimeoutMs: 'Per-request deadline for one provider call.',
      hintRefreshSeconds: 'How often the composer chip re-reads the figure.',
      overridden: 'overridden',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The next reading uses these values.',
      reset: 'Reset to defaults',
      persists: 'Stored in your profile; the route reads the row on every request.',
      readOnly: 'Read-only: this deployment does not persist settings.',
      numberInvalid: 'Must be a whole number within the allowed range.',
      rejected: 'The Host refused the write; the previous values are still in effect.',
      failed: 'Could not save: {message}',
      version: 'v{version}',
    }

    const zh = {
      title: '配额检查',
      summary: '编辑器状态栏的配额标签 — {refreshSeconds} 秒刷新。',
      summaryEmpty: '编辑器状态栏的配额标签。',
      labelCacheSeconds: '缓存秒数',
      labelTimeoutMs: '请求超时（毫秒）',
      labelRefreshSeconds: '浏览器刷新（秒）',
      hintCacheSeconds: '一次读取在再次询问提供方之前可被复用的时长。0 表示每次都询问。',
      hintTimeoutMs: '单次提供方调用的超时时间。',
      hintRefreshSeconds: '状态栏标签重新读取该数值的频率。',
      overridden: '已覆盖',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。下一次读取将使用这些值。',
      reset: '恢复默认',
      persists: '保存在你的配置中；路由每次请求都会读取该行。',
      readOnly: '只读：此部署不持久化设置。',
      numberInvalid: '必须是允许范围内的整数。',
      rejected: 'Host 拒绝了写入；原先的值仍然有效。',
      failed: '保存失败：{message}',
      version: 'v{version}',
    }

    /**
     * Bind one settings scope to a React subscription.
     * @param scope - the scope bound to the quota-check settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Read a snapshot's resolved row. A namespace this deployment does not
     * serve reports no row, which the card renders as nothing at all.
     * @param snapshot - the settings scope snapshot.
     * @returns the resolved row, or `undefined` when unreadable.
     */
    function rowOf(snapshot) {
      if (snapshot.status !== 'ready') return undefined
      return snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
    }

    /**
     * Build the Plugins-page card over one bound settings scope.
     * @param scope - the scope bound to the quota-check settings namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the slot renders.
     */
    function createCard(scope, t) {
      const useQuotaCheck = useScope(scope)

      return function QuotaCheckCard(props) {
        const snapshot = useQuotaCheck()
        const [draft, setDraft] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [status, setStatus] = React.useState(null)

        const row = rowOf(snapshot)
        if (row === undefined) return null

        if (props != null && props.view === 'summary') {
          return row.refreshSeconds === undefined
            ? t('summaryEmpty')
            : t('summary', { refreshSeconds: String(row.refreshSeconds) })
        }

        const disabled = !snapshot.writable
        const shown = draft ?? row
        const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}

        /** Validate and collect the staged edits into one ordered mutation. */
        const collect = () => {
          const ops = []
          for (const field of FIELDS) {
            const value = shown[field.key]
            if (String(value) === String(row[field.key])) continue
            const parsed = Number(value)
            if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
              return { error: 'numberInvalid' }
            }
            ops.push({ op: 'set', path: [field.key], value: parsed })
          }
          return { ops }
        }

        const save = () => {
          setError(null)
          const result = collect()
          if (result.error !== undefined) {
            setError(t(result.error))
            return
          }
          if (result.ops.length === 0) {
            setStatus(null)
            return
          }
          setStatus(t('saving'))
          Promise.resolve(scope.mutate(result.ops))
            .then((accepted) => {
              if (accepted === false) {
                setError(t('rejected'))
                setStatus(null)
                return
              }
              setDraft(null)
              setStatus(t('saved'))
            })
            .catch((cause) => {
              setStatus(null)
              setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
            })
        }

        const reset = () => {
          setDraft(null)
          setStatus(null)
          const ops = Object.keys(user)
            .filter((key) => FIELDS.some((field) => field.key === key))
            .map((key) => ({ op: 'unset', path: [key] }))
          if (ops.length === 0) return
          Promise.resolve(scope.mutate(ops)).catch((cause) => {
            setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
        }

        const overridden = Object.keys(user).some((key) => FIELDS.some((field) => field.key === key))

        return React.createElement(
          'div',
          { className: 'qc-page' },
          ...FIELDS.map((field) => React.createElement(
            'div',
            { className: 'qc-field', key: field.key },
            React.createElement(
              'div',
              { className: 'qc-row' },
              React.createElement('span', { className: 'qc-label' }, t(field.label)),
              Object.hasOwn(user, field.key)
                ? React.createElement('span', { className: 'qc-hint' }, `(${t('overridden')})`)
                : null,
            ),
            React.createElement('input', {
              className: 'qc-input',
              type: 'number',
              value: String(shown[field.key] ?? ''),
              disabled,
              'aria-label': t(field.label),
              onChange: (event) => {
                setStatus(null)
                setDraft({ ...shown, [field.key]: event.target.value })
              },
            }),
            React.createElement('span', { className: 'qc-hint' }, t(field.hint)),
          )),
          React.createElement(
            'div',
            { className: 'qc-row' },
            React.createElement('button', { type: 'button', className: 'qc-button', disabled, onClick: save }, t('save')),
            overridden
              ? React.createElement('button', {
                type: 'button', className: 'qc-button qc-button-quiet', disabled, onClick: reset,
              }, t('reset'))
              : null,
          ),
          React.createElement(
            'div',
            { className: 'qc-status' },
            status ?? (snapshot.writable ? t('persists') : t('readOnly')),
            ' ',
            t('version', { version: VERSION }),
          ),
          error === null ? null : React.createElement('div', { className: 'qc-error' }, error),
        )
      }
    }

    /**
     * Mount both surfaces: the statusbar chip and the Plugins-page card.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'dsh-quota-check: locale dictionary',
      )

      // The dock's owner declares the slot; injecting waits for it to exist, so
      // this registration does not depend on plugin load order.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'quota-check',
        order: 20,
      }, createChip()))

      // The card takes no injected props — it closes over its own bound scope —
      // so the entry declares the documented locale namespace and no inject.
      const scope = ctx.configForms.get(NAMESPACE)
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-quota-check#quota-check',
        locale: LOCALE_NS,
      }, createCard(scope, t)))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
