# Fork notes

This is Staxed's fork of [Archon](https://github.com/coleam00/Archon), rebased on
upstream v0.11.1. This file lists where it deviates from upstream and what a
deployment of it needs.

## Deviations from upstream

- **Subscription-only auth:** Claude Code, Codex and Grok run on their own
  subscription logins (OAuth); Archon never falls back to a provider API key.
- **Grok provider:** a Grok CLI provider alongside Claude and Codex.
- **Destructive-command guard:** refuses destructive commands from agent nodes
  (below).
- **Repo env limits:** a repo's config cannot set CLI homes or `ARCHON_*` names
  (below).
- **Pi gateway-only:** the Pi provider may only call the LLM gateway (below).
- **Inner agents stay inside their cwd:** workflow nodes get a cwd notice, and
  Claude's Write/Edit tools are denied outside the worktree and the run's
  artifacts, state and log dirs.
- **Missing MCP config on a `when:`-gated node** is a validation warning, not an
  error.
- **Model and effort per node (routes-2026-10-09.1):** every Claude node in
  `sdlc/`, `defaults/` (legacy included), `experimental/` and `maintainer/` names
  its tier and effort, from Stixed's routing decision
  (`stixed/.agent/docs/model-routing-2026-10-09.md`). Review and debug nodes are
  `medium` · high, unattended whole-ticket builds `medium` · high, other build,
  plan, research, verify and summary nodes `medium` · medium, classification and
  plain lookups `small` · medium. No node uses `large`. Codex tiers are
  `gpt-6-luna` / `gpt-6.1-sol` / `gpt-6.1-sol`. Provider test workflows
  (`test-workflows/`, `e2e-*`, `rasmus-tests/`) and the Codex/Pi variants keep
  their models, because the model is what they test. On an upstream merge, keep
  the fork's `model:`/`effort:` lines and re-run `bun run generate:bundled`.
- **Sub-cent cost caps** show as `$0.001`, not `$0.00`.
- **Short run ids on Postgres:** the id-prefix lookup (`workflow get|resume|abandon
<short-id>`, chat `/workflow` commands) casts the uuid to text before `LIKE`.
- **Resume after a lost owner:** `resume` on a `running` run whose recorded owner is
  this host and user, with nothing answering at its live-owner endpoint, marks it
  `failed` and resumes it. An owner recorded on another host or user is refused
  (use `abandon`).
- **`ARCHON_DOCKER_HOME`:** an absolute path that replaces `/.archon` as the home in
  Docker, so a container sharing a database with a host-side Archon records the same
  paths. `ARCHON_HOME` is still ignored in Docker.
- **Retired fork code:** the fork's knowledge base, its own OpenRouter and
  llama.cpp clients and its own tool loop are gone. Gateway models run through
  Pi, and project knowledge lives in Stixed project cards.

## Pi provider: LLM gateway only

On this host every HTTP model call goes through the metering gateway
`llm-metrics`, which holds the provider API keys. Archon holds none. The Pi
provider is locked to that gateway.

### How it works

- `assistants.pi.gatewayOnly` defaults to `true` in this fork. Only the
  install-level config (`~/.archon/config.yaml`) can set it to `false`: a repo's
  `.archon/config.yaml` that does is ignored with a warning, and a run cannot
  change it.
- `ARCHON_LLM_GATEWAY_URL` and `ARCHON_PI_MODELS_PATH` are read from Archon's own
  process environment (the deployment), never from a request's env, which carries
  the project's `env:`. A repo's `env:` and `assistants.pi.env` cannot set any
  `ARCHON_*` name (see "Repo env" below).
- With it on, a Pi node's model must be `gateway-<name>/<model-id>`. Built-in Pi
  vendors (`openrouter`, `xai`, `openai`, `google`, `anthropic`, …) are refused
  before any credential is read. `~/.pi/agent/auth.json`, `ARCHON_PI_AUTH_PATH`
  and vendor API-key env vars are not consulted: Pi gets an empty credential store.
- The provider must be defined in the gateway models file. Its `baseUrl` (and any
  per-model `baseUrl`) must sit under `$ARCHON_LLM_GATEWAY_URL`. Its `apiKey`
  (and any per-model `apiKey`) must be the placeholder `gateway`, or a `${VAR}`
  that is not a vendor key name (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, Pi's vendor
  variables): a literal may be a real key, and Pi reads a bare variable name as a
  reference. Headers must be literals (no `${VAR}` or `!command`), and it must
  send `X-Caller`.
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

### Residual: Pi's own tools

Pi's bash/read tools run in the Archon server process's environment, and Archon
has no hook point on them (the destructive-command guard does not cover Pi
either; its nodes say so). A Pi node can therefore read whatever that environment
holds. Accepted: the deployment holds no provider keys (the gateway does).

## Repo env

A repo's `.archon/config.yaml` `env:` reaches every provider's subprocess, so it
may not set the names that decide where the subscription CLIs keep their logins
and Archon's hooks, or any Archon setting: `HOME`, `CODEX_HOME`, `GROK_HOME`,
`CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and every `ARCHON_*` name. They are
dropped with a warning (`config.repo_env_forbidden_keys_ignored`); set them in the
deployment instead. Codex and Grok also run with `CODEX_HOME` / `GROK_HOME`
forced to the home Archon installed its hook dispatcher in.

The subscription CLIs' env never carries an API key, a base-URL override, the
switches that move Claude Code onto Bedrock, Vertex or Foundry, those clouds'
credentials (`AWS_*` keys and profile, `GOOGLE_APPLICATION_CREDENTIALS`,
`AZURE_*KEY`) or any `*_API_KEY` name (`shared/subscription-env.ts`).

Residual: Claude nodes load the repo's `.claude/settings.json` (setting source
`project`, needed for CLAUDE.md), and its `env` or `apiKeyHelper` could still
move Claude Code off the subscription. The SDK cannot drop only those keys from
one source; its parent-supplied managed settings are filtered to restrictive keys
and are dropped when the host has managed settings of its own, so this is left to
the host's managed Claude settings.

## Destructive-command guard

`packages/providers/src/shared/destructive-guard.ts` is a port of Stixed's Python
guard and shares its rules file and test list. It is the deterministic floor:
catastrophic cases only, and a block from a rule is a hard stop whose message tells
the agent to ask the user, not to find another way.

Rules come from `ARCHON_DESTRUCTIVE_RULES` (the deployment's env), else Stixed's
root-owned promoted copy `/usr/local/lib/stixed/.claude/scripts/destructive_rules.json`
(read directly on the host; the container needs that folder mounted read-only at the
same path), else a built-in copy of the same strict rules (`DEFAULT_RULES`, kept in
step with Stixed's file by a test), which is what the Archon VM uses. The
agent-writable `~/.archon/destructive-rules.json` is no longer read.

It follows a script fed to a shell on stdin (`bash -euo pipefail <<EOF`,
`printf ... | sh`, `cat <<EOF | bash`, `bash < x.sh`), a script written and run in
the same command (`cat > x.sh <<EOF ... EOF; bash x.sh`, `./x.sh`, `source x.sh`),
process substitution and the substitutions in an unquoted heredoc body. `find`
filters that match everything or are negated do not count as narrowing, a `find`
over the vault whose filter can match its `.md` notes is refused, and so is
`rsync --delete` into a protected folder.

Where it is stricter than the Python guard:

- A command it cannot parse is searched as raw text and refused when it holds a
  command the rules cover (`unparsed-destructive`, "rewrite it more simply"). A
  fault in the guard refuses the command.
- A recursive delete (`rm -r`, an unfiltered `find -delete`, `git clean -x`) of a
  path, or from a `cd`, holding an expansion it cannot resolve is refused
  (`unresolved-path`, "write the path out literally"), unless the path ends in a
  build folder (`node_modules`, `dist`, `.venv`, `build` ...). `$TMPDIR`, `$TMP`,
  `$TEMP` and `mktemp` count as temp paths. The shared case
  `while read f; do rm -rf "$f"; done` is refused here on purpose. `mv` of an
  unresolved source is not refused (a move is undoable, and `mv "$f" ...` is too
  common).
- Codex and Grok get the rules file the Archon server resolved through the hook
  spec, not their own env. A node hook that rewrites a call (`updatedInput`) has
  the rewritten call checked again, on every provider with hooks.

Still not covered: a script already on disk before the command (written by an
earlier call), and shells fed by anything whose output the guard cannot know
(`curl ... | sh`). Those are for the judged layer (Jev) above the floor.
