/**
 * dsh-quota-check — browser half: the quota chip in the composer statusbar.
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

    /**
     * Mount the chip.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      // The dock's owner declares the slot; injecting waits for it to exist, so
      // this registration does not depend on plugin load order.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'quota-check',
        order: 20,
      }, createChip()))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
