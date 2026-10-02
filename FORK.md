# Fork notes

This is Staxed's fork of [Archon](https://github.com/coleam00/Archon), rebased on
upstream v0.11.1. This file lists where it deviates from upstream and what a
deployment of it needs.

## Deviations from upstream

- **Subscription-only auth:** Claude Code, Codex and Grok run on their own
  subscription logins (OAuth); Archon never falls back to a provider API key.
- **Grok provider:** a Grok CLI provider alongside Claude and Codex.
- **Destructive-command guard:** refuses destructive commands from agent nodes
  (ported on a separate branch).
- **Pi gateway-only:** the Pi provider may only call the LLM gateway (below).
- **Inner agents stay inside their cwd:** workflow nodes get a cwd notice, and
  Claude's Write/Edit tools are denied outside the worktree and the run's
  artifacts, state and log dirs.
- **Missing MCP config on a `when:`-gated node** is a validation warning, not an
  error.
- **Sub-cent cost caps** show as `$0.001`, not `$0.00`.
- **Retired fork code:** the fork's knowledge base, its own OpenRouter and
  llama.cpp clients and its own tool loop are gone. Gateway models run through
  Pi, and project knowledge lives in Stixed project cards.

## Pi provider: LLM gateway only

On this host every HTTP model call goes through the metering gateway
`llm-metrics`, which holds the provider API keys. Archon holds none. The Pi
provider is locked to that gateway.

### How it works

- `assistants.pi.gatewayOnly` (in `.archon/config.yaml`) defaults to `true` in this
  fork. It can be set in config files but not relaxed per run.
- With it on, a Pi node's model must be `gateway-<name>/<model-id>`. Built-in Pi
  vendors (`openrouter`, `xai`, `openai`, `google`, `anthropic`, …) are refused
  before any credential is read. `~/.pi/agent/auth.json`, `ARCHON_PI_AUTH_PATH`
  and vendor API-key env vars are not consulted: Pi gets an empty credential store.
- The provider must be defined in the gateway models file. Its `baseUrl` (and any
  per-model `baseUrl`) must sit under `$ARCHON_LLM_GATEWAY_URL`. Its `apiKey` and
  headers must be literals (no `${VAR}` or `!command`), and it must send
  `X-Caller`.
- Pi substitutes `${VAR}` in `apiKey`/`headers` only, never in `baseUrl`, so Archon
  replaces `${ARCHON_LLM_GATEWAY_URL}` itself and hands Pi a per-call models.json
  holding only the selected provider. One tracked file therefore serves the host
  and containers.
- After the session resolves the model (including any upsert by a Pi extension),
  its `baseUrl` is checked again. A model that would call anything but the gateway
  is refused.

The code is in `packages/providers/src/community/pi/gateway.ts`.

### Provider definitions

`deploy/pi/models.gateway.json` defines `gateway-openrouter`, `gateway-openai`,
`gateway-xai`, `gateway-google` (`${ARCHON_LLM_GATEWAY_URL}/<provider>/v1`) and
`gateway-llamacpp` (`${ARCHON_LLM_GATEWAY_URL}/v1`, the gateway's local llama.cpp
route). Each sends `X-Caller: archon` with the placeholder `apiKey` `gateway` (Pi
wants a key; the gateway ignores it). The model lists are examples: add the ids you
use. Keep the file free of comments, because Archon parses it as plain JSON.

Archon reads the file from `ARCHON_PI_MODELS_PATH` when set, else from Pi's own
`$PI_CODING_AGENT_DIR/models.json` (default `~/.pi/agent/models.json`). The Docker
image copies `deploy/pi/` to `/app/deploy/pi/`.

Example node:

```yaml
- id: draft
  provider: pi
  model: gateway-openrouter/qwen/qwen3-coder
  prompt: ...
```

### Environment

Set these in both the Archon container and the sbx VM:

| Variable                    | Container / sbx VM                                                                                             | Host (dev)                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `ARCHON_LLM_GATEWAY_URL`    | `http://host.docker.internal:8093`                                                                             | `http://localhost:8093`                |
| `ARCHON_PI_MODELS_PATH`     | `/app/deploy/pi/models.gateway.json` (container) or `<archon checkout>/deploy/pi/models.gateway.json` (sbx VM) | `<repo>/deploy/pi/models.gateway.json` |
| `ARCHON_TELEMETRY_DISABLED` | `1`                                                                                                            | `1`                                    |
| `CLAUDE_BIN_PATH`           | output of `command -v claude`                                                                                  | same                                   |
| `CODEX_BIN_PATH`            | output of `command -v codex`                                                                                   | same                                   |

On the `ai-stack` Docker network the gateway is also reachable as
`http://llm-metrics:8093`.

- `ARCHON_TELEMETRY_DISABLED=1`: upstream sends anonymous PostHog telemetry
  unless this is set.
- `CLAUDE_BIN_PATH` / `CODEX_BIN_PATH`: point at the installed CLIs. Left unset,
  the Agent SDK can fall back to its bundled Claude Code, which goes stale against
  the installed one and has hung in sbx microVMs on the stream-json handshake.
  The container entrypoint only pins `CLAUDE_BIN_PATH` when it is unset. This
  replaces fork commit d03d9311.
- Optional: `PI_OFFLINE=1` stops Pi refreshing its model catalog over the network.
  It does not affect model calls.

To run Pi against a direct vendor anyway (not on this host), set
`assistants.pi.gatewayOnly: false` in the install-level config.
