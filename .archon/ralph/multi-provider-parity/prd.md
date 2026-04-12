# PRD: Multi-Provider Parity — OpenRouter, Llama.cpp, and Full Feature Surface

## Problem Statement

**Who**: Single-developer operator running Archon for AI-assisted development workflows.

**What**: Archon currently supports only two AI providers (Claude via `@anthropic-ai/claude-agent-sdk` and Codex via `@openai/codex-sdk`), both of which are opaque SDK wrappers that manage their own tool execution loops internally. This creates three problems:

1. **Provider lock-in**: No way to use open-weight models (Llama, Mistral, Qwen) or routing services (OpenRouter) that expose OpenAI-compatible chat/completions APIs.
2. **Feature asymmetry**: Codex lacks feature parity with Claude — `allowed_tools`/`denied_tools`, `hooks`, `mcp`, `skills`, `output_format`, and `systemPrompt` are Claude-only. The validator (`packages/workflows/src/validator.ts`) warns but silently skips these features for Codex nodes.
3. **Stateless-provider gap**: Claude and Codex SDKs manage their own message history and session state internally. Adding providers that use stateless HTTP APIs (OpenRouter, Llama.cpp) requires Archon to own the message history and tool execution loop — capabilities that don't exist today.

**Why**: The operator wants to choose the best model for each workflow node — a cheap local Llama for classification, OpenRouter for frontier models, Claude for complex agentic tasks — without losing any feature. Silent fallbacks and "v1 later" restrictions erode trust in the platform.

## Evidence

- Provider enum is hardcoded as `z.enum(['claude', 'codex'])` in `packages/workflows/src/schemas/workflow.ts:32` and `packages/workflows/src/schemas/dag-node.ts:120`.
- Model validation in `packages/workflows/src/model-validation.ts` is a binary Claude-or-not check.
- `packages/core/src/clients/factory.ts` has a two-case switch with a default throw.
- Knowledge capture (`packages/core/src/services/knowledge-capture.ts:171`) hardcodes `getAssistantClient('claude')` — KB is Claude-only regardless of config.
- Codex client (`packages/core/src/clients/codex.ts`) delegates tool execution entirely to the Codex SDK subprocess; Archon has no generic tool-execution loop.
- The `messages` table (`remote_agent_messages`) stores conversation history but is not used for AI session replay — both SDKs manage their own state.
- Token/cost data flows through `MessageChunk.tokens` and `MessageChunk.cost` but is **not persisted** to any database table.

## Proposed Solution

Add OpenRouter and Llama.cpp as first-class providers alongside Claude and Codex, with full feature parity across all four. Build an **agentic tool-execution loop** inside Archon for OpenAI-compatible providers (OpenRouter, Llama.cpp, and retroactively Codex for features the Codex SDK doesn't support). Persist message history in `remote_agent_messages` for stateless-provider replay. Bring Codex to parity with Claude's feature surface by routing unsupported features through the new tool loop. Make KB capture/compile/extract provider-configurable. Update the `archon-workflow-builder` workflow to understand all four providers and the bash-decomposition pattern.

## Key Hypothesis

A single agentic tool-execution loop that speaks the OpenAI chat/completions protocol can unify OpenRouter, Llama.cpp, and Codex feature gaps — without degrading Claude or Codex SDK native performance for features those SDKs already handle natively.

## What We're NOT Building

- **A model marketplace or discovery UI** — the operator knows their model IDs.
- **Provider-specific prompt tuning** — same prompt goes to all providers; model selection is the tuning knob.
- **Cross-provider automatic failover** — `fallbackModel` is a Claude SDK option for same-provider fallback within the Claude client; it stays as-is. Cross-provider failover (e.g., "if OpenRouter is down, switch to Claude") is out of scope.
- **Embedding or RAG pipelines** — knowledge base stays document-based.
- **Multi-tenant billing or quota management** — single-developer tool.
- **WebSocket or gRPC transport** — OpenAI-compatible HTTP only for new providers.

## Success Metrics

1. **Provider parity**: All five node types (command, prompt, bash, loop, knowledge-extract) execute identically on all four providers. No silent skips, no warnings-as-errors.
2. **Tool execution fidelity**: Tool calls via the Archon-managed loop produce identical `tool`/`tool_result` `MessageChunk` events as Claude SDK native tool calls.
3. **Session continuity**: A workflow can resume a failed run on OpenRouter/Llama.cpp using persisted message history — same behavior as Claude's `resumeSessionId`.
4. **Cost tracking**: Token usage and cost data for all providers persisted to a new `remote_agent_token_usage` table and surfaced in workflow events.
5. **KB provider-configurable**: `captureProvider` / `compileProvider` config fields select which provider runs KB capture and article compilation; the existing `captureModel` / `compileModel` fields name the model on that provider. Both provider fields default to `claude` for backward compatibility.
6. **Zero regression**: Existing Claude and Codex workflows execute without behavioral change. `bun run validate` passes.

## Decisions (previously open questions — all resolved before PRD generation)

1. **Tool schema translation**: Archon defines a canonical tool set mirroring the Claude SDK surface — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch` — in JSON Schema function-call format (`packages/core/src/clients/tool-definitions.ts`). This canonical set is consumed by the tool loop for OpenRouter / Llama.cpp / Codex-fallback. Claude's native SDK path continues to use the SDK's own tool definitions.
2. **Streaming protocol**: Always stream via SSE for all four providers. Parity mandate — workflow events must flow in real-time regardless of provider. Non-streaming is not exposed as a config option.
3. **Llama.cpp model management**: Archon does not manage llama-server lifecycle, model downloads, or GGUF files. The operator runs their own `llama-server` (or compatible) at the endpoint configured via `assistants.llamacpp.endpoint` (default `http://localhost:8080`). Archon only speaks to a running endpoint.
4. **MCP for non-Claude providers**: Use the `@modelcontextprotocol/sdk` client library to spawn and speak to MCP servers. A thin wrapper (`mcp-client.ts`) enumerates each server's tools, translates them into OpenAI function-call format, and merges them into the tool-loop tool list. We do not reimplement the MCP protocol — we consume it via the official SDK.
5. **Codex SDK bypass strategy**: Investigate `@openai/codex-sdk` during Phase 3 implementation. If it exposes native primitives for `allowed_tools` / `denied_tools` / `hooks` / `mcp` / `skills`, wire them up on the SDK path. If it does not, route those features through the Archon tool loop (the same path OpenRouter / Llama.cpp use) by calling the underlying OpenAI API directly with the Codex model ID. Either path ends at full parity — this is **Must**, not Should.

## Hard Constraints

These are non-negotiable and apply to every task in the implementation:

- **No silent fallbacks.** If a provider call fails, surface the error with a classified message. If a tool can't be executed, throw. If a model pairs with an unsupported feature, throw a loud startup or runtime error naming the model, feature, and node — never fall back to a degraded mode.
- **No feature gating by provider.** Every `Must` feature in the MoSCoW table works on all four providers. No "OpenRouter doesn't support X, skip it" branches.
- **No scope reduction to a prompt-only v1.** The agentic tool-execution loop ships as part of the same PRD — the entire MoSCoW Must column is one indivisible deliverable.
- **Zero regressions on existing Claude/Codex workflows.** Every bundled workflow in `.archon/workflows/defaults/` must run identically after the change. `bun run validate` stays fully green.
- **`@archon/workflows` zero-`@archon/core` dependency preserved.** All new provider wiring in workflows flows through `WorkflowDeps` / `IWorkflowAssistantClient` — no new direct imports of `@archon/core` from `@archon/workflows`.
- **Mock-isolation rules respected.** New test files that use `mock.module()` must land in their own `bun test` invocation split per the rules in `CLAUDE.md` and `.claude/rules/dx-quirks.md` — never in a shared batch with conflicting mocks.
- **Test co-location.** New tests live next to the code they exercise as `*.test.ts`, not in a separate `__tests__` directory.
- **Strict TypeScript, zero ESLint warnings.** No `any` without a justified inline comment. No `/* eslint-disable */` at file scope.
- **Worktree isolation preserved.** Tool executions run with the resolved `cwd` produced by `executor.ts` / `dag-executor.ts`, which already accounts for `@archon/isolation`. No tool implementation may traverse above its `cwd` or bypass worktree scoping.

## Users & Context

**Primary user**: Single developer operating Archon for AI-assisted coding workflows, with access to multiple AI providers (Anthropic API key, OpenRouter API key, local Llama.cpp server).

**Jobs to be done**:
- Use cheap/fast local models for classification and bash-decomposition nodes
- Use OpenRouter to access frontier models (Gemini, GPT-4.1, Llama 4) without separate SDK integrations
- Maintain full workflow feature surface regardless of provider choice
- Track cost across all providers to optimize spend

**Non-users**: This does not serve teams needing centralized provider management, billing aggregation, or model fine-tuning pipelines.

## Solution Detail

### MoSCoW Table

| Priority | Feature | Notes |
|----------|---------|-------|
| **Must** | OpenRouter provider client implementing `IAssistantClient` | OpenAI-compatible chat/completions with tool-use |
| **Must** | Llama.cpp provider client implementing `IAssistantClient` | OpenAI-compatible, local endpoint |
| **Must** | Agentic tool-execution loop for OpenAI-compatible providers | Handles tool_calls → execution → re-submission cycle |
| **Must** | Provider enum expansion to `'claude' \| 'codex' \| 'openrouter' \| 'llamacpp'` | Schemas, config types, factory, model validation |
| **Must** | Message history persistence for stateless providers | Use `remote_agent_messages` for replay on resume |
| **Must** | `allowed_tools`/`denied_tools` for all providers | Filter tool definitions before sending to API |
| **Must** | `output_format` (structured JSON) for all providers | Map to `response_format` in OpenAI-compatible APIs |
| **Must** | `systemPrompt` for all providers | Map to system message in chat/completions |
| **Must** | `hooks` for all providers | Execute hook logic in Archon's tool loop |
| **Must** | Session resume for stateless providers | Replay persisted messages on resume |
| **Must** | Cost/token tracking table and persistence | New `remote_agent_token_usage` table |
| **Must** | KB capture/compile provider-configurable | Separate `captureProvider` / `compileProvider` config fields; both default to `claude` for backward compatibility |
| **Must** | Update `archon-workflow-builder` for 4 providers | Schema reference, bash-decomposition pattern |
| **Must** | Model validation for new providers | `isModelCompatible()` extended |
| **Must** | Config types for new providers | `assistants.openrouter`, `assistants.llamacpp` in config |
| **Must** | `mcp` support for non-Claude providers | Translate MCP tool definitions to function-call format |
| **Must** | `skills` support for non-Claude providers | Load skill prompts and inject into system message |
| **Must** | Codex feature parity via tool loop fallback | Route unsupported Codex features through Archon's loop; no warnings-as-skips |
| **Must** | Streaming for OpenRouter and Llama.cpp | SSE chunk processing; parity with Claude/Codex streaming UX |
| **Must** | Rate limit handling and retry for new providers | Match existing exponential backoff pattern from Claude client |
| **Must** | Context-window management for stateless providers | Summarize oldest turns when approaching model context window; keep recent turns verbatim; fail loudly on summarization failure |
| **Must** | Tool-use capability floor / malformed-tool-call detection | Fail loudly after N consecutive malformed or empty tool-call attempts (configurable, default 3) |
| **Must** | GBNF grammar translation for Llama.cpp `output_format` | Translate JSON Schema to GBNF; pass via Llama.cpp `grammar` field (not `response_format`) |
| **Should** | Web UI provider selector | Conversation-level provider choice |

### MVP Definition

The MVP is **all Must items**. Every node type works on every provider with every feature. No gating, no restrictions, no silent fallbacks. The entire MoSCoW Must column ships as one unit.

## Technical Approach

All file paths verified by reading the codebase.

### 1. Provider Enum and Schema Expansion

**Files to modify:**
- `packages/workflows/src/schemas/workflow.ts:32` — Change `z.enum(['claude', 'codex'])` to `z.enum(['claude', 'codex', 'openrouter', 'llamacpp'])`
- `packages/workflows/src/schemas/dag-node.ts:120` — Same enum expansion in `dagNodeBaseSchema`
- `packages/workflows/src/model-validation.ts` — Extend `isModelCompatible()`:
  - OpenRouter: Accept any `provider/model` format (e.g., `anthropic/claude-3-haiku`, `meta-llama/llama-4-scout`)
  - Llama.cpp: Accept any string (model is loaded server-side)
  - Reject Claude aliases (`sonnet`, `opus`, `haiku`) for non-Claude providers
- `packages/core/src/config/config-types.ts` — Add `OpenRouterAssistantDefaults` and `LlamaCppAssistantDefaults` interfaces; extend `GlobalConfig.assistants` and `defaultAssistant` union
- `packages/workflows/src/deps.ts:229` — Expand `AssistantClientFactory` type from `'claude' | 'codex'` to the full provider union
- `packages/workflows/src/deps.ts:239-267` — Expand `WorkflowConfig.assistant` and `WorkflowConfig.assistants` to include new providers

### 2. New Provider Clients

**Files to create:**
- `packages/core/src/clients/openrouter.ts` — `OpenRouterClient implements IAssistantClient`
- `packages/core/src/clients/llamacpp.ts` — `LlamaCppClient implements IAssistantClient`

**File to modify:**
- `packages/core/src/clients/factory.ts` — Add cases for `'openrouter'` and `'llamacpp'` in `getAssistantClient()`

**Client architecture**: Both new clients share a common `OpenAICompatibleClient` base (or composition) that:
1. Accepts an OpenAI-compatible endpoint URL + API key from config
2. Builds `ChatCompletionRequest` with messages, tools, response_format
3. Sends via `fetch()` with SSE streaming support
4. Parses `ChatCompletionChunk` responses
5. Yields `MessageChunk` events matching the existing discriminated union (`packages/core/src/types/index.ts:195-229`)
6. Delegates tool execution to the agentic tool loop (see below)

**OpenRouter-specific**: `HTTP-Referer` header, `X-Title` header, model routing via `model` field, cost from response headers.

**Llama.cpp-specific**: Local endpoint (default `http://localhost:8080`), no API key, model loaded server-side. Structured output via the llama.cpp-native `grammar` request field carrying a GBNF grammar translated from the node's JSON Schema `output_format`. This is **not** the same as OpenAI's `response_format` — the translator lives in a dedicated module (see §3b below) and is used by `LlamaCppClient` only.

### 3. Agentic Tool-Execution Loop

**Files to create:**
- `packages/core/src/clients/tool-loop.ts` — Generic agentic tool-execution loop
- `packages/core/src/clients/tool-definitions.ts` — Archon's canonical tool definitions in JSON Schema / OpenAI function-call format
- `packages/core/src/clients/tools/` — Tool implementations:
  - `read.ts`, `write.ts`, `edit.ts` — File operations
  - `glob.ts`, `grep.ts` — Search (delegate to ripgrep / fast-glob where practical)
  - `bash.ts` — Shell execution via `execFileAsync` from `@archon/git`
- `packages/core/src/clients/mcp-client.ts` — Thin wrapper over `@modelcontextprotocol/sdk` client that spawns MCP server processes and exposes their tools to the loop
- `packages/core/src/clients/skill-loader.ts` — Loads skill definitions and produces system-prompt injections plus scoped tool allowlists

**Activation rule**: The loop runs whenever Archon's own runtime needs to execute tool calls — that is, for OpenRouter, Llama.cpp, and Codex-for-features-the-Codex-SDK-lacks. Claude's native SDK path and Codex's native SDK path are untouched when they already support the requested feature set.

**Loop algorithm**:

1. Build the request: system prompt (base + skill injections), `messages[]` history, `tools[]` (Archon canonical + MCP-provided + skill-provided, filtered by `allowed_tools`/`denied_tools`), optional `response_format` / `grammar`, and any streaming options.
2. Call the chat/completions endpoint.
3. Emit the streamed `assistant` chunks to the workflow event stream as they arrive.
4. If the assistant turn has no `tool_calls`, emit a final `result` chunk and exit the loop (single-turn path; zero extra overhead for prompt-only nodes).
5. If there are `tool_calls`, for each call: (a) fire the `PreToolUse` hook, (b) execute the tool implementation with the resolved working directory, (c) fire the `PostToolUse` hook, (d) append the tool result to the message history and emit a `tool_result` chunk.
6. Increment the malformed-attempt counter only if the model emitted an empty, unparseable, or schema-violating `tool_calls` structure — successful tool calls reset it. If the counter reaches `maxMalformedToolCallAttempts` (default 3, configurable per-node via `toolLoop.maxMalformedAttempts`), throw a loud, classified error naming the model, node, and last malformed payload — no silent retry, no fallback.
7. Go back to step 1 with the updated history.

**Tool definitions**: Archon owns a canonical set mirroring the Claude SDK tool surface — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch` — each expressed once as a JSON Schema function definition and translated per-provider (OpenAI-format for OpenRouter / Llama.cpp / Codex-fallback; Claude SDK already ships its own definitions for its native path).

**Working directory and isolation**: The loop receives a resolved `cwd` from `executor.ts` / `dag-executor.ts`, which already accounts for worktree isolation via `@archon/isolation`. All tool implementations execute with that `cwd` and never traverse above it. Bash execution uses `execFileAsync` (never `exec`) per project rules. Worktree-isolated runs get worktree-scoped file access automatically.

**Feature mapping inside the loop**:
- `allowed_tools`: Filter the canonical + MCP + skill tool list before sending to the API.
- `denied_tools`: Exclude from the tool list before sending.
- `hooks`: Fire registered hook callbacks at the same lifecycle points Claude SDK fires them (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, etc.), with the same payload shape.
- `output_format`: For OpenRouter, use `response_format: { type: 'json_schema', json_schema: ... }`. For Llama.cpp, translate the JSON Schema to GBNF (see §3b) and pass via the `grammar` field. For Codex fallback, use whichever path the Codex model supports.
- `systemPrompt`: Prepended as the first `system` message in the messages array.
- `mcp`: MCP client connects to each configured server, enumerates its tools, translates them to OpenAI function-call format, and merges them into the tool list. Env var expansion in MCP server configs happens at loop invocation time (same semantics as Claude SDK path).
- `skills`: Skill loader reads skill definitions, extracts system-prompt content and scoped tool allowlists, and merges both into the loop context. The loop treats a skill-loaded node as equivalent to a node with an expanded system prompt and a restricted tool set.

### 3b. JSON Schema → GBNF Translator (Llama.cpp-only)

**File to create:**
- `packages/core/src/clients/grammar/json-schema-to-gbnf.ts` — Pure translator function

**Purpose**: Llama.cpp constrains output via GBNF (a custom grammar format) passed in the `grammar` field of the chat/completions request, not via OpenAI's `response_format`. Nodes that declare `output_format` expect structured JSON regardless of provider, so Llama.cpp needs a deterministic JSON Schema → GBNF translation.

**Implementation options** (decide during implementation, not in this PRD): prefer a maintained library (e.g., `json-schema-to-gbnf` or an upstream llama.cpp utility) over hand-rolling. If no library exists that covers the subset of JSON Schema Archon actually uses (object, string, number, boolean, enum, array of primitives/objects, required, nested objects), implement a minimal translator covering exactly that subset and throw a loud classified error for any JSON Schema feature outside the covered subset — no silent degradation.

**Tests**: Round-trip tests — for every JSON Schema Archon uses in existing workflows, verify the GBNF translator produces valid GBNF that constrains a real llama.cpp instance's output to schema-conforming JSON.

### 3c. Context-Window Management (Stateless Providers)

**File to create:**
- `packages/core/src/clients/context-window.ts` — Window accounting, summarization trigger, and summary persistence

**Purpose**: OpenRouter and Llama.cpp models have declared context windows (e.g., 200k for Claude-on-OpenRouter, 128k for Llama 3.1, 32k for smaller models). The tool loop replays the full conversation history on every call, so long-running sessions will eventually exceed the window. Silent truncation is forbidden. Failure is loud. Automatic summarization is how we keep long sessions working without truncation.

**Algorithm**:

1. Before each loop iteration, estimate token count of the outgoing request (system + tool definitions + full message history). Use the model's declared tokenizer where known; fall back to a conservative character-based estimator when unknown.
2. If estimated tokens ≤ `window × reservationThreshold` (default 0.75, configurable), send the request unchanged.
3. Otherwise, select the oldest contiguous run of turns (skipping any already-summarized entries) whose removal brings the estimate under the threshold.
4. Call the same provider with a summarization prompt over those turns. On success, insert a synthetic `system` message tagged `summary` in the messages table, linking the summarized turn IDs. Mark the original turns as `summarized: true` so they're excluded from future replay.
5. Replay becomes: base system prompt + ordered summary messages (in chronological position) + non-summarized verbatim turns.
6. On summarization failure (API error, malformed summary, summary still too large after retry), throw a loud classified error naming the conversation, node, and window budget — no silent truncation, no discarding of history.

**Schema changes** (small extension to existing tables, not a new table): see the migration described in §4. The existing `role` column (`user`/`assistant`/`system`) is preserved unchanged; the new `kind` column is an orthogonal discriminator (`text`/`tool_call`/`tool_result`/`summary`) that lets the replay layer distinguish plain text turns from tool invocation records, tool results, and summarization entries without overloading `role`. Migration is backward-compatible — existing rows default to `kind='text'`, `summarized=false`, `summary_of=NULL`.

**Claude / Codex unaffected**: Their SDKs own their own context management. This path only runs for stateless providers inside the Archon tool loop.

### 4. Message History Persistence for Stateless Providers

**Files to modify:**
- `packages/core/src/db/messages.ts` — Extend `addMessage()` / `listMessages()` to round-trip OpenAI-format message parts: `system`, `user`, `assistant` (with optional `tool_calls`), `tool` (tool-result messages with `tool_call_id`), and `summary` (synthetic entries produced by §3c). Metadata JSONB already stores `toolCalls`; the extension is mostly a widened discriminator plus the new `kind` / `summarized` / `summary_of` columns described in §3c.

**Migration:**
- New migration file adding three columns to `remote_agent_messages`:
  - `kind VARCHAR(32) NOT NULL DEFAULT 'text'` — one of `text | tool_call | tool_result | summary`
  - `summarized BOOLEAN NOT NULL DEFAULT FALSE`
  - `summary_of UUID[] NULL` — IDs of turns collapsed into a summary row
- Backfill is trivial: existing rows remain `kind='text'`, `summarized=false`, `summary_of=NULL`. Claude/Codex replay paths ignore these columns.

**Resume flow for stateless providers**:
1. On resume, load all non-summarized messages for the conversation plus the ordered set of `summary` messages via `listMessages()`.
2. Reconstruct the OpenAI `messages[]` array: base system prompt → summary messages in chronological position → verbatim turns (user / assistant-with-tool_calls / tool results).
3. Send the reconstructed history to the provider as the next call's context.
4. Continue the tool loop (§3) from where the previous run stopped — the loop state machine is idempotent on completed tool calls already present in history.

**Contrast with Claude/Codex**: Claude SDK uses `resumeSessionId` to resume from its own persisted state. Codex uses thread resumption. Both keep their existing behavior. The message-replay path is only for stateless providers routed through the Archon tool loop.

### 5. Cost/Token Tracking

**Migration to create:**
- New migration file adding `remote_agent_token_usage` table:
  ```sql
  CREATE TABLE remote_agent_token_usage (
    id UUID PRIMARY KEY,
    workflow_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
    node_id VARCHAR(255),
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(255) NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
  ```

**Files to modify:**
- `packages/workflows/src/dag-executor.ts` — After each node's `result` chunk, persist token usage via store
- `packages/workflows/src/store.ts` — Add `recordTokenUsage()` to `IWorkflowStore`
- `packages/core/src/workflows/store-adapter.ts` — Implement `recordTokenUsage()` bridging to new DB module
- `packages/core/src/db/` — New `token-usage.ts` module for CRUD operations

### 6. Knowledge Base Provider Configurability

**Files to modify:**
- `packages/core/src/services/knowledge-capture.ts:171` — Replace hardcoded `getAssistantClient('claude')` with `getAssistantClient(mergedConfig.knowledge.captureProvider)`, passing the resolved model from `mergedConfig.knowledge.captureModel`.
- `packages/core/src/services/knowledge-capture.ts:260` — Same change in `extractKnowledgeFromContext` (the `knowledge-extract` workflow node path).
- `packages/core/src/services/knowledge-flush.ts:459` — Replace hardcoded `getAssistantClient('claude')` with `getAssistantClient(mergedConfig.knowledge.compileProvider)`.
- `packages/core/src/services/knowledge-flush.ts:958` — Same change for the secondary hardcoded call site in `knowledge-flush.ts`.
- `packages/core/src/config/config-types.ts` — Add `captureProvider` and `compileProvider` fields to the `KnowledgeConfig` interface, each typed as the full provider union (`'claude' | 'codex' | 'openrouter' | 'llamacpp'`). Defaults: both `'claude'` for backward compatibility with existing config files that only set `captureModel` / `compileModel`.

**Config shape** (final):

```yaml
knowledge:
  enabled: true
  captureProvider: openrouter      # new, defaults to 'claude'
  captureModel: meta-llama/llama-4-scout
  compileProvider: claude          # new, defaults to 'claude'
  compileModel: sonnet
  flushDebounceMinutes: 10
  domains:
    - architecture
    - decisions
    - patterns
    - lessons
    - connections
```

**Backward compatibility**: Existing config files that omit `captureProvider` / `compileProvider` continue to work — both default to `claude`, preserving current behavior. No migration needed.

**Validation**: `config-loader.ts` rejects `captureProvider` / `compileProvider` values outside the four-provider enum with a loud startup error — no silent coercion.

### 7. Codex Feature Parity (Must)

**File to modify:**
- `packages/core/src/clients/codex.ts` — Bring Codex to full parity with Claude's feature surface. This is a **Must**, not a "Should" or "nice-to-have."

**Implementation plan**:

1. **Research first** — Read `@openai/codex-sdk`'s current API surface (the installed version in `package.json`, not speculated future versions). Enumerate which of `allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`, `output_format`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox` the SDK supports natively.
2. **Native-first wiring** — For features the Codex SDK supports, wire them up directly on the SDK path. Remove the corresponding "Claude-only" warning branches in `packages/workflows/src/validator.ts` and `packages/workflows/src/dag-executor.ts`.
3. **Tool-loop fallback for gaps** — For features the Codex SDK does not support natively, route Codex through the Archon tool loop (§3) by calling the underlying OpenAI chat/completions API directly with the Codex model ID. The fallback path must maintain the same `MessageChunk` streaming interface and produce identical observable behavior to the native Claude path.
4. **Dispatch logic** — `CodexClient.sendQuery()` inspects the `options` it receives. If every requested feature is SDK-supported, it uses the native Codex SDK path. Otherwise it falls through to the tool loop with the same message/tool/feature surface. The dispatch is transparent to callers — `getType()` still returns `'codex'`.
5. **Observability** — Emit a workflow event tagging whether a Codex node ran on the SDK path or the tool-loop path, so debugging and cost auditing can distinguish them.

**No regression**: Existing Codex workflows that don't use unsupported features must continue to run on the native SDK path with identical behavior.

### 8. Workflow Builder Update

**File to modify:**
- `.archon/workflows/defaults/archon-workflow-builder.yaml`

**Changes to `extract-intent` node** (lines 43–86): extend the `output_format` schema so the structured intent captures per-node provider decisions. Add a `proposed_providers` field (string) alongside `proposed_nodes` that records the chosen provider and model for each node and the reasoning (e.g., "analyze: openrouter/haiku — cheap classification; implement: claude/opus — heavy agentic work").

**Changes to `generate-yaml` node** (lines 88–205):
- Extend the schema reference block (lines 108–152) to document per-node `provider:` with the four accepted values and a one-line capability profile for each:
  - `claude` — full agentic coding SDK, best for heavy implementation work, premium cost
  - `codex` — OpenAI's agentic SDK, comparable to Claude for code work, premium cost
  - `openrouter` — cloud gateway to 300+ models; use `model: <vendor>/<model>` format; variable cost from free to premium
  - `llamacpp` — local endpoint; zero marginal cost; capability depends on the loaded model
- Add a rule to the Rules block (lines 184–197) capturing the bash-decomposition heuristic: "When a node is pointed at a weaker provider (typically small local Llama.cpp models), prefer splitting tool-heavy work into a preceding `bash:` node that gathers context via deterministic shell commands, then feeds the output into a `prompt:` node that only needs to reason over the gathered text. This avoids forcing a weak model to emit well-formed tool calls."
- Add a rule: "All features (`allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`, `output_format`, `systemPrompt`) work identically on all four providers."
- Add examples of per-node `provider:` / `model:` syntax.
- Keep the existing `bash` vs `prompt` vs `command` vs `loop` guidance — those rules still hold and now interact with the new provider-aware bash-decomposition rule.

### 9. Config and Validation Updates

**Files to modify:**
- `packages/core/src/config/config-loader.ts` — Add defaults for `assistants.openrouter` and `assistants.llamacpp`; merge logic for new provider configs
- `packages/core/src/config/config-types.ts` — New interfaces:
  ```typescript
  interface OpenRouterAssistantDefaults {
    model?: string;        // e.g., "anthropic/claude-3-haiku"
    apiKey?: string;       // Or from OPENROUTER_API_KEY env var
    siteUrl?: string;      // HTTP-Referer header
    siteName?: string;     // X-Title header
  }
  interface LlamaCppAssistantDefaults {
    model?: string;        // Model name (informational; model loaded server-side)
    endpoint?: string;     // Default: http://localhost:8080
  }
  ```
- `packages/workflows/src/validator.ts` — Remove Claude-only warnings for features that now work on all providers
- `packages/workflows/src/loader.ts` — Update provider validation to accept new enum values
- `packages/workflows/src/dag-executor.ts` — Update `resolveNodeProviderAndModel()` to handle new providers

### 10. Environment Variables

New env vars:
- `OPENROUTER_API_KEY` — API key for OpenRouter
- `LLAMACPP_ENDPOINT` — Llama.cpp server URL (default: `http://localhost:8080`)

Existing env vars unchanged:
- `CLAUDE_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` — Claude auth
- `OPENAI_API_KEY` — Codex auth

## Implementation Phases

### Phase 1: Foundation — Provider Enum + OpenAI-Compatible Base

| Task | Status | Files |
|------|--------|-------|
| Expand provider enum in schemas | Not started | `packages/workflows/src/schemas/workflow.ts`, `dag-node.ts` |
| Expand provider types in deps | Not started | `packages/workflows/src/deps.ts` |
| Expand config types for new providers | Not started | `packages/core/src/config/config-types.ts`, `config-loader.ts` |
| Extend model validation | Not started | `packages/workflows/src/model-validation.ts` |
| Build `OpenAICompatibleClient` base | Not started | `packages/core/src/clients/openai-compatible.ts` (new) |
| Build agentic tool-execution loop | Not started | `packages/core/src/clients/tool-loop.ts` (new) |
| Define Archon canonical tool definitions in OpenAI function format | Not started | `packages/core/src/clients/tool-definitions.ts` (new) |
| Implement canonical tool executors (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch) | Not started | `packages/core/src/clients/tools/*.ts` (new) |
| JSON Schema → GBNF translator for Llama.cpp `output_format` | Not started | `packages/core/src/clients/grammar/json-schema-to-gbnf.ts` (new) |
| Context-window manager + summarization trigger | Not started | `packages/core/src/clients/context-window.ts` (new) |
| MCP client wrapper over `@modelcontextprotocol/sdk` | Not started | `packages/core/src/clients/mcp-client.ts` (new) |
| Skill loader (system-prompt + tool-allowlist injection) | Not started | `packages/core/src/clients/skill-loader.ts` (new) |
| Migration: `remote_agent_messages` — add `kind`, `summarized`, `summary_of` | Not started | New migration file |

### Phase 2: New Providers

| Task | Status | Files |
|------|--------|-------|
| Implement `OpenRouterClient` | Not started | `packages/core/src/clients/openrouter.ts` (new) |
| Implement `LlamaCppClient` | Not started | `packages/core/src/clients/llamacpp.ts` (new) |
| Extend client factory | Not started | `packages/core/src/clients/factory.ts` |
| Message history replay for resume | Not started | `packages/core/src/db/messages.ts` |
| Cost/token tracking table + persistence | Not started | Migration + `packages/core/src/db/token-usage.ts` (new) |

**Parallel opportunity**: Phase 2 OpenRouter and Llama.cpp clients can be built in parallel since they share the `OpenAICompatibleClient` base from Phase 1.

### Phase 3: Feature Parity

| Task | Status | Files |
|------|--------|-------|
| `allowed_tools`/`denied_tools` in tool loop | Not started | `packages/core/src/clients/tool-loop.ts` |
| `hooks` in tool loop | Not started | `packages/core/src/clients/tool-loop.ts` |
| `mcp` translation to function-call format | Not started | `packages/core/src/clients/tool-loop.ts`, `packages/core/src/clients/mcp-client.ts` (created in Phase 1) |
| `skills` injection into system prompt | Not started | `packages/core/src/clients/tool-loop.ts` |
| `output_format` for all providers | Not started | `packages/core/src/clients/openai-compatible.ts` |
| `systemPrompt` for all providers | Not started | `packages/core/src/clients/openai-compatible.ts` |
| Codex feature parity: SDK-native first, tool-loop fallback for gaps (§7) | Not started | `packages/core/src/clients/codex.ts` |
| Remove Claude-only warnings in validator | Not started | `packages/workflows/src/validator.ts` |

**Parallel opportunity**: Tool loop features (allowed_tools, hooks, mcp, skills) can be implemented independently once the base loop exists.

### Phase 4: Knowledge Base + Workflow Builder

| Task | Status | Files |
|------|--------|-------|
| KB capture provider-configurable (+ `captureProvider` config field) | Not started | `packages/core/src/services/knowledge-capture.ts:171`, `packages/core/src/services/knowledge-capture.ts:260`, `packages/core/src/config/config-types.ts` |
| KB compile provider-configurable (+ `compileProvider` config field) | Not started | `packages/core/src/services/knowledge-flush.ts:459`, `packages/core/src/services/knowledge-flush.ts:958`, `packages/core/src/config/config-types.ts` |
| Update `archon-workflow-builder` — per-node provider decisions in `extract-intent` output schema, four-provider docs + bash-decomposition rule in `generate-yaml` prompt | Not started | `.archon/workflows/defaults/archon-workflow-builder.yaml` |
| Update DAG executor `resolveNodeProviderAndModel()` for new providers | Not started | `packages/workflows/src/dag-executor.ts` |
| Update store adapter for new deps | Not started | `packages/core/src/workflows/store-adapter.ts` |

### Phase 5: Integration + Validation

| Task | Status | Files |
|------|--------|-------|
| End-to-end tests: all node types × all providers × all feature axes (`allowed_tools`, `hooks`, `mcp`, `skills`, `output_format`, `systemPrompt`) | Not started | `packages/workflows/src/*.test.ts`, `packages/core/src/**/*.test.ts` |
| Resume + replay tests for stateless providers | Not started | `packages/core/src/**/*.test.ts` |
| Context-window overflow + summarization tests | Not started | `packages/core/src/clients/context-window.test.ts` |
| Malformed-tool-call-attempt-floor tests (fail-loud after default 3) | Not started | `packages/core/src/clients/tool-loop.test.ts` |
| JSON Schema → GBNF round-trip tests against a real llama.cpp instance | Not started | `packages/core/src/clients/grammar/json-schema-to-gbnf.test.ts` |
| Codex native-path vs tool-loop-path dispatch tests | Not started | `packages/core/src/clients/codex.test.ts` |
| Cost/token tracking integration tests | Not started | `packages/core/src/db/token-usage.test.ts` |
| Mock-isolation per-package split respected (update `package.json` test scripts if new `mock.module()` sites conflict) | Not started | `packages/core/package.json`, `packages/workflows/package.json` |
| `bun run validate` passes (type-check + lint + format + tests) | Not started | — |
| Update `CLAUDE.md` and `.claude/rules/workflows.md` with new provider docs | Not started | `CLAUDE.md`, `.claude/rules/workflows.md` |

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Build a generic `OpenAICompatibleClient` base shared by OpenRouter and Llama.cpp | Both use the same chat/completions protocol; DRY without premature abstraction (Rule of Two consumers) |
| 2 | Own the tool-execution loop in Archon rather than delegating to SDKs | Required for stateless providers; also enables feature parity for Codex; single loop to maintain |
| 3 | Use `remote_agent_messages` for session replay | Table already exists with the right schema; avoids new state management |
| 4 | New `remote_agent_token_usage` table rather than extending `workflow_events.data` | Enables querying cost across workflows, time ranges; events JSONB is unindexed |
| 5 | Separate `captureProvider` / `compileProvider` config fields for KB (not an inline `provider:model` string) | Explicit, type-safe against the four-provider enum, backward compatible (defaults to `'claude'`), easy to validate at config-load time, matches the separate `captureModel` / `compileModel` split that already exists |
| 6 | Codex parity by SDK-native first, tool-loop fallback for gaps | Research `@openai/codex-sdk` surface during Phase 3; use native features where they exist, fall through to the Archon tool loop for gaps. Either path ends at full parity |
| 7 | Llama.cpp assumes user-managed server | Archon is a coding platform, not a model serving platform; managing GGUF files is out of scope |
| 8 | No cross-provider failover | `fallbackModel` is a Claude SDK option for same-provider fallback; cross-provider failover adds complexity without a concrete use case |
| 9 | Automatic context-window management via summarization (not truncation) for stateless providers | Silent truncation is forbidden; unbounded history replay will exceed model context windows on long sessions; summarization keeps sessions running while preserving the most recent turns verbatim |
| 10 | Fail loudly after N consecutive malformed tool-call attempts (default 3, configurable) | Weak models can thrash indefinitely emitting malformed tool calls; bounding retries with a classified error protects the operator's time and cost while surfacing the real problem (model isn't a fit for this node) |
| 11 | JSON Schema → GBNF translator for Llama.cpp `output_format` parity | Llama.cpp structured output uses GBNF grammars via the `grammar` field, not OpenAI's `response_format`. Translating JSON Schema → GBNF is the only way to keep `output_format` working identically across all four providers |
| 12 | Canonical Archon tool set mirroring the Claude SDK surface | Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch — single definition in JSON Schema function format, translated per-provider. Avoids divergence between "what works on Claude" and "what works elsewhere" |


## Validation Notes

Validated against codebase on 2026-04-11. Corrections applied:

1. **Test directory paths (Phase 5)**: Changed `packages/workflows/src/__tests__/` to `packages/workflows/src/*.test.ts` and `packages/core/src/__tests__/` to `packages/core/src/**/*.test.ts`. Tests are co-located with source files, not in separate `__tests__` directories.
2. **Knowledge-flush hardcoded provider**: Added specific line references -- `knowledge-flush.ts:459` and `knowledge-flush.ts:958` both hardcode `getAssistantClient('claude')`, matching the same pattern as `knowledge-capture.ts:171`.

All other technical references verified:
- 18 file paths: all exist
- Line numbers for provider enum (workflow.ts:32, dag-node.ts:120), deps.ts:229, types/index.ts:195-229, knowledge-capture.ts:171: all accurate
- Function names (`isModelCompatible`, `getAssistantClient`, `resolveNodeProviderAndModel`, `addMessage`, `listMessages`, `createWorkflowDeps`, `execFileAsync`): all verified
- DB table names (`remote_agent_messages`, `remote_agent_workflow_runs`, `remote_agent_workflow_events`, `remote_agent_conversations`): match migration schema
- Interface names (`IAssistantClient`, `IWorkflowAssistantClient`, `IWorkflowStore`, `AssistantClientFactory`, `WorkflowConfig`, `KnowledgeConfig`, `TokenUsage`, `MessageChunk`): all exist at referenced locations
- No existing API endpoints for token/cost tracking -- new table proposal is correct
- `WORKFLOW_EVENT_TYPES` constant verified in `packages/workflows/src/store.ts:10-29`
