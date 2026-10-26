# krouter — multi-provider LLM router

One OpenAI-compatible endpoint. Many providers. Zero downtime.

krouter is a smart gateway between your CLI/IDE tools (Claude Code, Codex, Cursor,
Cline, Copilot, OpenCode, anything that speaks OpenAI) and every LLM provider you
have. It routes each request across providers with **3-tier fallback**
(subscription → cheap → free), translates request/response formats
(OpenAI ↔ Anthropic), tracks quota and usage, and compresses tokens before they
hit the wire.

Inspired by [9router](https://9router.com). Zero dependencies — one Node.js file.

```
┌─────────────┐
│  Your CLI   │  Claude Code, Codex, Cursor, Cline, OpenCode…
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────────┐
│            krouter (smart router)           │
│  • RTK token saver (cut tool_result tokens) │
│  • Caveman / Ponytail output shaping        │
│  • Format translation (OpenAI ↔ Anthropic)  │
│  • Quota tracking + auto failover           │
└──────┬──────────────────────────────────────┘
       │
       ├─→ [Tier 1: SUBSCRIPTION] your paid accounts
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM, MiniMax, DeepSeek…
       │   ↓ budget limit
       └─→ [Tier 3: FREE] free providers
```

## Quick start

```bash
# requires Node.js >= 18
npm start            # or: node server.js
```

Dashboard opens at `http://localhost:20128/dashboard`. Add a provider, copy the
API key, point your tool at the endpoint:

```
Endpoint:  http://localhost:20128/v1
API key:   kr-…  (shown in the dashboard)
Model:     kr/auto     ← router picks the best available provider
           glm/glm-4.7 ← pin to a provider by alias
           combo/free  ← use a combo (ordered fallback chain)
```

## Install anywhere

No npm install, no docker. One folder, one Node.js file:

```bash
./install.sh           # linux/macos — links `krouter` into PATH
./install.bat          # windows — adds folder to PATH + desktop shortcut
```

Then from any terminal:

```bash
krouter start                                   # start server
krouter status                                  # health, providers, keys
krouter provider add --name GLM --alias glm \
  --base https://open.bigmodel.cn/api/paas/v4 --keys sk-a,sk-b,sk-c
krouter keys add glm sk-d sk-e sk-f             # bulk add keys
krouter models refresh glm                      # re-fetch model list
krouter usage                                   # usage stats
krouter logs 10                                 # recent requests
```

## CLI

```
krouter status                      server health, providers, keys
krouter start [--port 20128]        start server (detached)
krouter stop                        stop server

krouter provider ls
krouter provider add --name X --alias x --base https://… [--keys k1,k2] [--models m1,m2] [--tier cheap]
krouter provider rm <id|alias>
krouter provider test <id|alias>

krouter keys add <id|alias> k1 k2 k3     bulk add api keys (invisible chars sanitized)
krouter keys ls <id|alias>

krouter models ls
krouter models refresh <id|alias>

krouter inject ls / add / rm / toggle
krouter inject add --pattern 'mb/*' --prompt '…'
krouter inject add --pattern 'mb/*' --transform fiction-deep

krouter usage
krouter logs [N]

krouter config set --url http://127.0.0.1:20128 --key <routerApiKey>
```

## Tunneling (public URL from anywhere)

Expose your local krouter over the internet via Cloudflare — no port forwarding,
no firewall changes. Works behind NAT. `cloudflared` is auto-downloaded if
missing:

```bash
krouter tunnel start                  # quick tunnel → https://*.trycloudflare.com
krouter tunnel start --domain api.example.com   # your own domain (named tunnel)
krouter tunnel status
krouter tunnel stop
```

Point any remote tool at the tunnel URL, or share it with your team. The CLI
remembers running tunnels in `~/.krouter/tunnels.json`.


### curl

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer kr-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"kr/auto","messages":[{"role":"user","content":"hello"}]}'
```

Streaming (`"stream": true`) returns standard OpenAI SSE. If the first provider
fails (429/5xx/quota), krouter transparently retries the next one in the chain.

## Configuration

Everything is stored in `data/config.json` next to `server.js`. The dashboard
writes it; you can also edit it by hand.

### Providers

| field        | meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `name`       | display name                                                            |
| `alias`      | short id used in model ids (`glm/glm-4.7`)                              |
| `kind`       | `openai` (incl. OpenRouter/custom), `anthropic` (native Messages API)   |
| `tier`       | `subscription` / `cheap` / `free` — fallback order                      |
| `baseUrl`    | provider base, e.g. `https://api.openai.com`                            |
| `apiKey`     | key sent as `Authorization: Bearer …` / `x-api-key`                     |
| `models`     | optional list; leave empty to auto-fetch `/models`                      |
| `priority`   | tie-breaker inside a tier (lower first)                                 |

### Why `kr/auto`?

When the requested model does not map to a provider, krouter builds the chain
from tier order (subscription → cheap → free) and walks it until one succeeds.
Quota-exhausted providers are skipped locally without burning a request.

## Token savers

- **RTK** (default ON) — compresses `tool_result` / long user content (git diff,
  `ls`, `grep` output…) before routing. Diff context lines are trimmed, duplicate
  lines deduped, blank runs collapsed. Lossless for the parts that matter; fails
  open (if compression would not shrink the text, the original is sent).
- **Caveman mode** (0–5) — injects a terse-style system prompt so replies stay
  technical but compact. 0 = off, 5 = maximum terseness.
- **Ponytail** (off/lite/full/ultra) — "lazy senior dev" prompt: minimal,
  YAGNI-first code.
- Header `X-Krouter-Token-Saver: off` (or `X-9Router-Token-Saver: off`) bypasses
  all input savers for a single request.

## Prompt injections (per model)

Rules inject a system prompt into every request whose model id matches a pattern:

| pattern                  | scope                                |
| ------------------------ | ------------------------------------ |
| `mb/zai-org/GLM-5.3`     | that exact model                     |
| `mb/*`                   | every model of one provider          |
| `*`                      | every request, all providers         |
| `mb/zai-org/*`           | every model of one vendor on provider |

All matching enabled rules apply in list order. `prepend` merges the prompt into
the leading system message; `append` pushes a system message after the
conversation (some reasoning models ignore trailing system messages — prepend is
the reliable position). Manage rules in the dashboard (Injections tab) or:

```bash
curl http://localhost:20129/api/injections -H 'Content-Type: application/json' \
  -d '{"pattern":"mb/*","prompt":"Akhiri jawaban dengan [MB].","position":"prepend"}'

curl http://localhost:20129/api/injections/test -H 'Content-Type: application/json' \
  -d '{"pattern":"mb/*"}'   # preview matching model ids
```

Header `X-Krouter-Inject: off` bypasses injections for one request.

## Endpoints

| method | path                       | notes                                              |
| ------ | -------------------------- | -------------------------------------------------- |
| GET    | `/v1/models`               | union of provider models + `kr/auto` + combos      |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat (streaming + non-streaming) |
| POST   | `/v1/messages`             | Anthropic-native input, translated and routed      |
| GET    | `/dashboard`               | management UI                                      |
| GET    | `/api/state`               | config + usage (localhost-only unless keyed)       |
| POST   | `/api/providers…`          | add / edit / delete / test providers               |
| POST   | `/api/combos…`             | create / delete combos                             |
| POST   | `/api/settings`            | token savers, logging, api key                     |
| POST   | `/api/quota`               | per-provider quota limits                          |
| GET    | `/api/logs`                | recent requests (only when logging enabled)        |
| GET    | `/health`                  | healthcheck                                        |

## Environment variables

| var             | default | meaning                       |
| --------------- | ------- | ----------------------------- |
| `KROUTER_PORT`  | `20128` | listen port                   |
| `KROUTER_HOST`  | `0.0.0.0` | bind address (use `127.0.0.1` to lock to localhost) |
| `KROUTER_DATA`  | `./data` | config + request log directory |

> Port 20128 is 9router's default. If the real 9router is already running on
> this machine, start krouter on another port, e.g.
> `set KROUTER_PORT=20129 && node server.js` (see `run-dev.bat`).

## Claude Code / Codex / Cursor setup

Point the tool at the router and forget about it:

```bash
# Claude Code (OpenAI-compatible mode)
export OPENAI_BASE_URL=http://localhost:20128/v1
export OPENAI_API_KEY=kr-…
```

Any tool that accepts a custom OpenAI base URL works.

## Differences from 9router

krouter is an independent, minimal, zero-dependency implementation of the same
idea. It lacks 9router's OAuth flows (Claude Code / Codex / Copilot login
bridges), the MITM IDE intercept, cloud sync, tunnels, proxy pools and its own
free-provider catalogue. What it does have: the routing, the fallback, the
translation, the token savers, the dashboard — in one readable file you control.

## License

MIT
