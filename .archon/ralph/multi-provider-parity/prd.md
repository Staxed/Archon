# Multi-Provider Parity — Product Requirements

## Overview

**Problem**: Archon supports only two AI providers (Claude and Codex), both opaque SDK wrappers that manage their own tool execution loops. This creates provider lock-in, feature asymmetry (Codex lacks `allowed_tools`, `hooks`, `mcp`, `skills`, `output_format`, `systemPrompt`), and no path to stateless providers (OpenRouter, Llama.cpp) that require Archon to own message history and tool execution.

**Solution**: Add OpenRouter and Llama.cpp as first-class providers alongside Claude and Codex, with full feature parity across all four. Build an agentic tool-execution loop inside Archon for OpenAI-compatible providers. Persist message history for stateless-provider replay. Bring Codex to parity with Claude's feature surface. Make KB capture/compile provider-configurable.

**Branch**: `ralph/multi-provider-parity`

---

## Goals & Success

### Primary Goal
Enable the operator to choose the best model for each workflow node — cheap local Llama for classification, OpenRouter for frontier models, Claude for complex agentic tasks — without losing any feature.

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| Provider parity | All 5 node types execute identically on all 4 providers | No silent skips or warnings-as-errors in test suite |
| Tool execution fidelity | Archon-managed loop produces identical `tool`/`tool_result` `MessageChunk` events as Claude SDK native | E2E test comparison |
| Session continuity | Resume on OpenRouter/Llama.cpp using persisted message history | Resume integration tests |
| Cost tracking | Token usage and cost persisted for all providers | Query `remote_agent_token_usage` after workflow run |
| KB provider-configurable | `captureProvider`/`compileProvider` config fields select provider | Config validation + KB tests |
| Zero regression | Existing Claude/Codex workflows unchanged | `bun run validate` fully green |

### Non-Goals (Out of Scope)
- **Model marketplace or discovery UI** — operator knows their model IDs
- **Provider-specific prompt tuning** — same prompt goes to all providers; model selection is the tuning knob
- **Cross-provider automatic failover** — `fallbackModel` stays Claude-only same-provider fallback
- **Embedding or RAG pipelines** — KB stays document-based
- **Multi-tenant billing or quota** — single-developer tool
- **WebSocket or gRPC transport** — OpenAI-compatible HTTP only for new providers
- **Llama.cpp model/server management** — operator runs their own server

---

## User & Context

### Target User
- **Who**: Single developer operating Archon for AI-assisted coding workflows
- **Role**: Has access to Anthropic API key, OpenRouter API key, local Llama.cpp server
- **Current Pain**: Locked into two premium providers; can't use open-weight models or routing services; Codex features silently skipped; no cost visibility

### User Journey
1. **Trigger**: Operator wants to use a cheap local model for a classification node and OpenRouter for a frontier model in the same workflow
2. **Action**: Sets `provider: llamacpp` or `provider: openrouter` with `model:` per-node in workflow YAML; configures endpoints/keys in `.archon/config.yaml`
3. **Outcome**: All node types and features work identically regardless of provider; cost tracked per-node

---

## UX Requirements

### Interaction Model
- **Config**: `assistants.openrouter` and `assistants.llamacpp` blocks in `.archon/config.yaml`
- **Env vars**: `OPENROUTER_API_KEY`, `LLAMACPP_ENDPOINT` (default `http://localhost:8080`)
- **Workflow YAML**: `provider:` field accepts `claude | codex | openrouter | llamacpp` at workflow and node level
- **CLI**: No new commands; existing `workflow run`, `workflow list`, `workflow status` work unchanged
- **Web UI (Should)**: Provider selector per conversation

### States to Handle
| State | Description | Behavior |
|-------|-------------|----------|
| Missing API key | OpenRouter key not set | Loud startup error naming the provider and missing env var |
| Endpoint unreachable | Llama.cpp server not running | Classified error: "Cannot reach llama.cpp endpoint at {url}" |
| Malformed tool calls | Model emits invalid tool_calls | Counter increments; after 3 consecutive, throw classified error naming model, node, and payload |
| Context window exceeded | Stateless provider session too long | Auto-summarize oldest turns; fail loudly if summarization fails |
| Model incompatible | Claude alias used for non-Claude provider | Loud validation error at workflow load time |

---

## Technical Context

### Patterns to Follow
- **Client interface**: `packages/core/src/types/index.ts:363-382` — `IAssistantClient` with `sendQuery()` returning `AsyncGenerator<MessageChunk>` and `getType()`
- **Client factory**: `packages/core/src/clients/factory.ts:26-37` — switch-based provider instantiation
- **Provider gating in DAG executor**: `packages/workflows/src/dag-executor.ts:361-619` — `resolveNodeProviderAndModel()` with per-provider option assembly
- **Feature degradation pattern**: `dag-executor.ts:398-484` — Codex unsupported features emit warnings; extends to new providers
- **Dependency injection**: `packages/workflows/src/deps.ts:300-308` — `WorkflowDeps` injects factory, store, config; `@archon/workflows` never imports `@archon/core`
- **Config merging**: `packages/core/src/config/config-loader.ts:172-209` — defaults + env overrides + repo config
- **Test co-location**: Tests live next to source as `*.test.ts`; `mock.module()` requires separate `bun test` invocations

### Types & Interfaces
```typescript
// packages/core/src/types/index.ts:363-382
export interface IAssistantClient {
  sendQuery(prompt: string, cwd: string, resumeSessionId?: string,
    options?: AssistantRequestOptions): AsyncGenerator<MessageChunk>;
  getType(): string;
}

// packages/workflows/src/deps.ts:229 — must widen to 4 providers
export type AssistantClientFactory = (provider: 'claude' | 'codex') => IWorkflowAssistantClient;

// packages/core/src/config/config-types.ts — new interfaces needed
interface OpenRouterAssistantDefaults {
  model?: string;        // e.g., "anthropic/claude-3-haiku"
  apiKey?: string;       // Or from OPENROUTER_API_KEY env var
  siteUrl?: string;      // HTTP-Referer header
  siteName?: string;     // X-Title header
}
interface LlamaCppAssistantDefaults {
  model?: string;        // Informational; model loaded server-side
  endpoint?: string;     // Default: http://localhost:8080
}
```

### Architecture Notes
- `@archon/workflows` has zero dependency on `@archon/core` — all new provider wiring flows through `WorkflowDeps`
- Claude SDK and Codex SDK are complete agentic runtimes; OpenAI-compatible APIs are bare stateless endpoints requiring Archon to build its own tool execution loop
- Message history in `remote_agent_messages` stores role/content/metadata JSONB but isn't used for AI replay
- Sessions table uses `VARCHAR(20)` for `ai_assistant_type` — no migration needed for new provider strings
- Knowledge base hardcodes `getAssistantClient('claude')` at 4 locations: `knowledge-capture.ts:171,260` and `knowledge-flush.ts:459,958`
- The agentic tool-execution loop is the single largest new capability — it must handle tool_calls detection, tool execution, result injection, and re-submission for all stateless providers
- Canonical tool set mirrors Claude SDK surface: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch

### Key Decisions
| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Single `OpenAICompatibleClient` base shared by OpenRouter and Llama.cpp | Both use the same chat/completions protocol; DRY with two consumers |
| 2 | Own the tool-execution loop in Archon | Required for stateless providers; enables Codex parity; single loop to maintain |
| 3 | Use `remote_agent_messages` for session replay | Table already exists; avoids new state management |
| 4 | New `remote_agent_token_usage` table | Enables querying cost across workflows/time; events JSONB is unindexed |
| 5 | Separate `captureProvider`/`compileProvider` config fields for KB | Type-safe, backward compatible, matches existing `captureModel`/`compileModel` split |
| 6 | Codex parity: SDK-native first, tool-loop fallback for gaps | Research SDK surface during implementation; either path ends at full parity |
| 7 | Llama.cpp assumes user-managed server | Archon is a coding platform, not a model serving platform |
| 8 | JSON Schema to GBNF translator for Llama.cpp output_format | Llama.cpp uses GBNF grammars via `grammar` field, not `response_format` |
| 9 | Context-window management via summarization for stateless providers | Silent truncation forbidden; summarization keeps sessions running |
| 10 | Fail loudly after N consecutive malformed tool-call attempts (default 3) | Bounds retries, surfaces model-isn't-a-fit errors clearly |

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | Provider enum + type expansion | 1 | — |
| US-002 | Config loader defaults for new providers | 2 | US-001 |
| US-003 | Canonical tool definitions (JSON Schema) | 3 | — |
| US-004 | Tool implementations: file ops (read, write, edit) | 4 | US-003 |
| US-005 | Tool implementations: search + shell (glob, grep, bash) | 5 | US-003 |
| US-006 | Tool implementations: web (web-fetch, web-search) | 6 | US-003 |
| US-007 | Agentic tool-execution loop core | 7 | US-003, US-004, US-005, US-006 |
| US-008 | MCP client wrapper | 8 | US-003 |
| US-009 | Skill loader | 9 | US-003 |
| US-010 | JSON Schema to GBNF translator | 10 | — |
| US-011 | Context-window manager + summarization | 11 | — |
| US-012 | DB migrations (messages columns + token usage table) | 12 | — |
| US-013 | OpenAI-compatible base client | 13 | US-007, US-011 |
| US-014 | OpenRouter client | 14 | US-013 |
| US-015 | Llama.cpp client | 15 | US-013, US-010 |
| US-016 | Client factory expansion + barrel exports | 16 | US-014, US-015 |
| US-017 | Message history replay for stateless providers | 17 | US-012, US-013 |
| US-018 | Cost/token tracking persistence layer | 18 | US-012 |
| US-019 | Tool loop feature integration (allowed_tools, denied_tools, output_format, systemPrompt) | 19 | US-007 |
| US-020 | Tool loop hooks lifecycle | 20 | US-007 |
| US-021 | Tool loop MCP + skills integration | 21 | US-007, US-008, US-009 |
| US-022 | Codex feature parity (SDK-native + tool-loop fallback) | 22 | US-007, US-019, US-020, US-021 |
| US-023 | DAG executor new provider branching + validator cleanup | 23 | US-001, US-016, US-019, US-020, US-021 |
| US-024 | KB provider configurability | 24 | US-001, US-002 |
| US-025 | Workflow builder update (4-provider awareness) | 25 | US-001 |
| US-026 | Token usage wiring in DAG executor | 26 | US-018, US-023 |
| US-027 | Tests: tool implementations + definitions | 27 | US-004, US-005, US-006 |
| US-028 | Tests: tool loop + context-window + GBNF | 28 | US-007, US-010, US-011 |
| US-029 | Tests: provider clients + message replay + resume | 29 | US-014, US-015, US-017 |
| US-030 | Tests: Codex dispatch + KB + token tracking | 30 | US-022, US-024, US-026 |
| US-031 | Integration validation + docs update | 31 | US-023, US-027, US-028, US-029, US-030 |

### Dependency Graph
```
US-001 (provider types)     US-003 (tool defs)     US-010 (GBNF)   US-011 (ctx-window)   US-012 (migrations)
    |                          / | | \                  |                  |                   / |
    v                         v  v v  v                 |                  |                  v  v
US-002 (config)        004  005 006 008 009             |                  |              017  018
    |                    \   |  /   /  /                |                  |               |
    v                     v  v v  v  v                  |                  v               |
US-024 (KB)              US-007 (tool loop)             |            US-013 (OAI base)    |
US-025 (wf builder)         / | \                       |              /       \          |
                           v  v  v                      v             v         v          |
                      019  020  021                  US-015      US-014         |          |
                        \   |  /                     (llama)     (openrouter)   |          |
                         v  v v                         \         /             |          |
                       US-022 (Codex)                  US-016 (factory)        |          |
                             \                                                 v          v
                              v                                            US-017      US-018
                          US-023 (DAG executor)                              |            |
                               |                                             v            v
                               v                                         US-029       US-030
                          US-026 (token wiring)
                               |
                               v
                    027, 028, 029, 030 (tests)
                               |
                               v
                          US-031 (validation)
```

---

## Validation Requirements

Every story must pass:
- [ ] Type-check: `bun run type-check`
- [ ] Lint: `bun run lint`
- [ ] Tests: `bun run test`
- [ ] Format: `bun run format:check`

Full validation: `bun run validate`

---

## Hard Constraints

- **No silent fallbacks** — surface errors with classified messages; never fall back to degraded mode
- **No feature gating by provider** — every Must feature works on all four providers
- **No scope reduction to prompt-only v1** — tool-execution loop is indivisible from provider support
- **Zero regressions** — existing Claude/Codex workflows unchanged; `bun run validate` green
- **`@archon/workflows` zero `@archon/core` dependency** — all wiring through `WorkflowDeps`
- **Mock-isolation rules** — new `mock.module()` test files in separate `bun test` invocations
- **Test co-location** — `*.test.ts` next to source, not in `__tests__/` directories
- **Strict TypeScript, zero ESLint warnings** — no `any` without justification
- **Worktree isolation preserved** — tool implementations respect resolved `cwd`

---

*Generated: 2026-04-12*
