# dsh-quota-check

One statusbar figure for the provider the current session is using: the remaining
balance on a pure API-billing route, or the plan quota on a subscription route.
The chip sits in the composer statusbar — the row under the composer card, flush
right so it lands directly beneath the model selector — and reads:

- **`$91.81`** — DeepSeek API balance (granted / topped-up breakdown in the tooltip)
- **`$12.34`** — OpenRouter remaining credits (bought / used in the tooltip)
- **`GLM 27%`** — z.ai / BigModel Coding Plan quota, fullest window (5h, weekly, and
  MCP windows with their reset times in the tooltip)
- **`$8.75`** — LiteLLM key budget (`/key/info`: budget, spend, remaining), which is
  also the fallback shape tried for any other route that has a base URL
- **`Claude 100%`**, **`Codex 32%`**, **`Grok 92%`**, **`Cursor 64%`** — the
  subscription plans' own meters, read from the credential the CLI already left on
  this machine: `~/.claude/.credentials.json`, `~/.codex/auth.json`,
  `~/.grok/auth.json`, and Cursor's `~/.config/cursor/auth.json` or IDE database.
  The tooltip lists every window (session, weekly, credits, on-demand) with its
  reset time.
- **`OmniRoute 100%`** — the fullest window across the upstream connections an
  OmniRoute deployment holds, read from OmniRoute's own `GET /api/providers` and
  `GET /api/usage/<connectionId>`. The tooltip names each connection's plan and
  its windows (`DeepSeek · Credits $91.27 left`, `SuperGrokPro · Weekly 7% left,
  resets …`).

Metered quota figures count **down**: the chip shows what is left, not what is
spent, and colors itself by headroom — green at ≥50% remaining, yellow at ≥25%,
orange at ≥10%, red below.

Any other provider renders nothing: the statusbar never grows a "no data" row.
That is the case for local inference (vLLM) and for per-request API billing with
no balance route.

A reading that **failed** — a rejected key, an unreachable endpoint, a provider
that answered with an error — is the one exception: the chip renders dimmed as
`quota ?` with the reason in its tooltip, because silence there would hide a
broken setup behind "nothing to show". Clicking it retries.

## What you get

- **One statusbar figure, no provider setup.** The chip follows the session's own
  model selection; nothing has to be pointed at a provider. The row's own
  cadences and deadline are edited from the **Plugins** page's card (see
  [Configure](#configure)).
- **The key never reaches the browser.** The host half owns the credential and the
  outbound request, and the browser half only draws the formatted text it returns.
- **One read per provider, cached.** A rerender, a session switch, or a second tab
  shares one cached reading instead of multiplying provider traffic.
- **Subscription plans are read where the CLI left them.** Claude, Codex, Grok, and
  Cursor meters come from the credentials already on this machine, and a rotated
  token is written back the way the CLI writes it.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start, and
> the Plugins card cannot save into it — the editor refuses a write an overlay
> would win.

```sh
dsh plugin --profile web add github:maci0/dsh-quota-check
dsh plugin --profile web update dsh-quota-check   # refresh later
```

For work on this checkout, `dsh plugin --profile web add link:/path/to/dsh-quota-check`
also works: `link:` keeps the profile pointing at the working copy, so
`npm run build` is what ships a source change — no reinstall. Then restart
`dsh web`: `dsh plugin add` appends the package to `dsh.profile.bundles`, and
bundles are frozen at boot, so a restart is what mounts the plugin. Do **not** also paste the
`id: quota-check` row from `cordis.patch.yml` into the profile's own patch:
`insert` does not dedupe ids.

## How it works

- **Host half** (`src/index.ts`, built to `lib/index.js`) serves
  `GET /quota-check?provider=<id>`. It resolves the provider's profile from the
  LLM registry plus the settings document, resolves the credential through
  `ctx.credentials` (falling back to `process.env`), calls the
  provider, and returns one JSON report. The provider key never leaves this
  process; readings are cached for a minute per provider, so a rerender, a
  session switch, or a second tab never multiplies provider traffic.
  `?refresh=1` forces a fresh read.
- **Browser half** (`lib/client.js`) reads `modelSelection` from the session's
  projections, asks that route for the selected provider, and draws the returned
  text in `conversation.composer.dock`. It is pushed to the right edge of the
  dock and then pulled back by the composer card's own inset plus the send
  control, so the figure sits under the model selector at any viewport width. A
  click re-reads; otherwise the chip refreshes on the host's configured cadence.
- **Probes** (`src/probes.ts`) are the pure rules: which endpoint answers for a
  route, and how its payload becomes the chip text and tooltip lines. A route's
  configured base URL decides when it names a known host; the provider id only
  decides when no base URL is configured. That distinction is what keeps
  `google-vertex-anthropic` (host `*.googleapis.com`) away from the Claude Code
  subscription credential while a bare `anthropic` route reads it. A route that
  names no known vendor and still has a base URL is asked for a LiteLLM key
  budget, which is how a proxy deployment gets recognized at all; a host without
  that route answers 404 and renders no chip. OmniRoute is the one probe with two
  rounds: it is recognized by route id, because the host is whatever machine runs
  it, then asks `/api/providers` for the connection ids and `/api/usage/<id>` for
  each connection that is live and publishes its quota. A chip for an OmniRoute
  route is therefore one listing plus one request per visible connection.
- **Local credentials** (`src/local-usage.ts`) are the port of the `quota-widget`
  fetchers: file paths, expiry skews, refresh bodies, and the atomic 0600
  write-back that keeps the CLI signed in. Only Claude, Codex, and Grok ever
  rotate a token; Cursor's session token is long-lived and rotates in the IDE.
  Grok's token endpoint is discovered at runtime, and its two billing meters
  (weekly credits, monthly spend) are two requests, so a probe may read more than
  one URL and still report when only one answered.

Adding a key-based probe is one function in `src/probes.ts` plus a case in
`tests/probes.test.ts`; adding a subscription provider is that plus a credential
reader in `src/local-usage.ts`. A probe whose endpoint names ids the route
configuration cannot carry — OmniRoute's per-connection usage — declares
`requests` instead of `url`, and reads its own listing before the host asks each
id.

## Configure

Three fields, all editable from the Web client: open **Plugins** → the
**quota-check** row → **Configure**. The card validates the schema's bounds
before the write, saves every changed field in one update, and marks the fields
you have overridden with a **Reset to defaults** control. Every field is
`volatile()`, so a save reaches the running route: the host re-reads the row per
request and drops its served readings, which is why a new cache window or
cadence applies to the next poll instead of waiting for a restart.

The same row can be set by hand in the profile's own `cordis.patch.yml`:

```yaml
- id: quota-check
  config:
    cacheSeconds: 60      # seconds one reading is served; 0 re-asks every time
    timeoutMs: 10000      # per-provider request deadline
    refreshSeconds: 300   # browser re-read cadence; reported to the chip
```

| Field | Default | Bounds | Meaning |
|---|---|---|---|
| `cacheSeconds` | `60` | 0–3600 | How long one reading is served before the provider is asked again. `0` asks every time. |
| `timeoutMs` | `10000` | 1–60000 | Per-request deadline for one provider call. |
| `refreshSeconds` | `300` | 10–3600 | The cadence the host reports to the chip, which re-reads at that interval. |

## Security

The route is registered behind the composition's trust fence
(`ctx.connection.requestRejection`), so it answers only same-origin,
authenticated callers, exactly like the harness's own browser routes. Responses
carry formatted figures only — never a key, never a raw provider body, never a
token.

Subscription credentials stay on this machine: they are read from the CLI's own
files and sent only to the vendor that issued them (`api.anthropic.com`,
`chatgpt.com`, `cli-chat-proxy.grok.com`, `cursor.com`). A rotated token is
written back the way the CLI writes it — same file, same fields, mode 0600, one
atomic rename — so the plugin never signs a CLI out. The Claude usage request
deliberately wears Claude Code's own User-Agent, because Anthropic rate-limits
that endpoint per agent.

## Development

```sh
npm install          # first run only (typescript, @types/node, cordis, carrier)
npm run typecheck
npm test             # probes, credentials, route, and the real-composition boot
npm run build        # tsc -> lib/*.js
```

`npm test` includes the real-composition case: the plugin mounts into a real
Cordis `Context` beside the real HTTP carrier on an OS-assigned port, the route
is driven over real HTTP, and disposing the fiber must withdraw it.

Verify the route by hand once the plugin is mounted, from the same browser that
has the Web client open (the route is behind the session cookie):

```
http://127.0.0.1:3080/quota-check?provider=deepseek-official
```

## Limits

- **OmniRoute has no per-route figure** — the router holds the upstream accounts, so a quota is only knowable per connection. The chip shows the fullest window across them and the tooltip names each plan; which account one request spends is the router's decision, so the plugin does not attribute it to a DSH route. A read is one listing plus one request per visible connection (21 on the reference box), cached for `cacheSeconds`.
- **The subscription probes follow route identity** — a route must be named after the vendor or answer on the vendor's own host. A reseller that proxies Claude on `omniroute`'s host therefore shows nothing rather than the local Claude Code plan, and Vertex-hosted Claude (`google-vertex-anthropic`) is deliberately excluded.
- **A rotated token is written to the CLI's own file** — the plugin refreshes Claude, Codex, and Grok credentials and writes them back atomically at mode 0600. That keeps the CLI signed in, but it means this plugin is a writer in `~/.claude`, `~/.codex`, and `~/.grok`. Cursor's session token has no refresh path at all.
- **Cursor credential reading needs `node:sqlite`** — the IDE database fallback imports it dynamically, so a runtime without that built-in reads only `~/.config/cursor/auth.json` and reports no Cursor chip from the database alone.
- **No settings card** — the three `Config` fields are changed from the profile patch, not from Settings. A card would need a settings namespace and a browser surface, which nothing here consumes yet.

## Licence

MIT. See [LICENSE](LICENSE).
