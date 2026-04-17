# LLM Knowledge Base System — Product Requirements

## Overview

**Problem**: Every new Archon session starts from zero context. The AI agent must re-discover project architecture, past decisions, known patterns, and lessons learned — typically by spawning sub-agents, grepping the codebase, reading git logs, and scanning dozens of files. This reconstructs ~20,000+ tokens of context that was already known in prior sessions, wasting tokens, adding latency, and losing cross-session knowledge.

**Solution**: A persistent, auto-maintained knowledge base that gives Archon cross-conversation memory using a 4-stage pipeline: CAPTURE (extract decisions/lessons after session end), COMPILE (synthesize into structured concept articles), VALIDATE (cross-reference against git history for staleness), QUERY (load index files into agent context at session start). No vector database, no embeddings, no RAG — the agent navigates markdown via hierarchical indexes, like a wiki.

**Branch**: `ralph/llm-knowledge-base-system`

---

## Goals & Success

### Primary Goal
Reduce context reconstruction cost by 10x while improving accuracy of project-specific decisions through persistent cross-session knowledge.

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| Context reconstruction tokens | ~2,000 per session (down from ~20,000+) | Compare token counts for initial context loading with/without KB |
| Session ramp-up time | Agent productive from first message | Qualitative assessment of session transcripts |
| Repeated mistake rate | Constraints captured once, applied consistently | Review KB articles vs. session decisions |
| Knowledge coverage | Growing corpus of decisions, patterns, lessons | `knowledge status` CLI command |
| Staleness rate | <10% of articles flagged stale | Validate step cross-references git changes |

### Non-Goals (Out of Scope)
- **Vector database / embeddings / RAG** — Agent navigates markdown indexes directly (Karpathy insight)
- **External knowledge ingestion** — Internal project knowledge only (decisions, patterns, lessons from Archon sessions)
- **Multi-user knowledge sharing** — Single-developer tool; no access control or collaborative editing
- **Real-time knowledge updates during sessions** — Capture happens after session end, not mid-conversation
- **Automatic code generation from knowledge** — KB informs the agent; doesn't generate code directly

---

## User & Context

### Target User
- **Who**: Single developer using Archon for AI-assisted coding across multiple projects and sessions
- **Role**: AI-assisted development practitioner managing multiple repos
- **Current Pain**: Every session starts cold — agent rediscovers architecture, past decisions, and lessons by spawning sub-agents and reading dozens of files

### User Journey
1. **Trigger**: Developer starts a new Archon session on a project they've worked on before
2. **Action**: System auto-loads knowledge index (~500 tokens) + relevant articles (~1,500 tokens) into agent context
3. **Outcome**: Agent is immediately productive — knows project architecture, past decisions, and learned constraints without rediscovery

### Jobs to Be Done
- "When I start a new session, the agent should already know what we decided last time"
- "When the agent encounters a constraint we've hit before, it should remember the lesson"
- "I want to see what the system has learned about my project over time"
- "I shouldn't have to repeat architectural decisions across sessions"

---

## UX Requirements

### Interaction Model

**Automatic (invisible to user):**
- Post-session capture: Haiku extracts decisions/lessons from conversation transcript
- Debounced compile: Sonnet synthesizes daily logs into structured articles (~10min after session end)
- Session start injection: index.md loaded into agent context automatically

**CLI commands (explicit management):**
- `knowledge flush [--project owner/repo]` — Manual compile trigger
- `knowledge status [--project owner/repo]` — Show KB stats (articles, last flush, staleness)
- `knowledge lint [--project owner/repo]` — Validate KB against git history

**Workflow integration:**
- Engine-level post-workflow capture (automatic)
- Optional explicit `knowledge-extract` nodes in workflows for richer extraction

### States to Handle
| State | Description | Behavior |
|-------|-------------|----------|
| Empty | No knowledge captured yet (first session) | Skip KB injection; agent works normally without it |
| Fresh logs only | Capture ran but no compile yet | Include unprocessed daily logs as supplementary raw context |
| Compiled | Articles exist, index up to date | Load index.md + navigate to relevant articles on demand |
| Stale | Articles flagged by validation | Include staleness warnings; agent treats flagged articles with lower confidence |
| Flushing | Compile in progress | Serve existing compiled state; new flush waits (file lock) |
| Error | Capture or compile failed | Log error; agent works without KB (fail-open, never block sessions) |

---

## Technical Context

### Patterns to Follow
- **Path resolution**: `packages/paths/src/archon-paths.ts:235-277` — Follow `getProjectSourcePath(owner, repo)` pattern for new `getProjectKnowledgePath`, `getGlobalKnowledgePath`, etc.
- **Config types**: `packages/core/src/config/config-types.ts:93-187` — Add `knowledge` section to `RepoConfig` following existing `docs`, `env` patterns
- **Service pattern**: `packages/core/src/services/cleanup-service.ts:27-40,555-595` — Lazy logger, config constants, interval scheduler, result interfaces
- **CLI commands**: `packages/cli/src/commands/workflow.ts:4-46,79-112` — Commander.js subcommands, lazy logger, event rendering
- **Prompt building**: `packages/core/src/orchestrator/prompt-builder.ts:12-37,114-185` — Context section formatting, `buildOrchestratorPrompt()` and `buildProjectScopedPrompt()`
- **Post-workflow hooks**: `packages/workflows/src/executor.ts:641-653` — Insert after completion check, fire-and-forget pattern
- **Event subscription**: `packages/workflows/src/event-emitter.ts:170-254` — Singleton emitter, `subscribe()` / `subscribeForConversation()`, `WorkflowEmitterEvent` union type

### Types & Interfaces
```typescript
// Key types to use or extend (from codebase exploration)

// packages/paths/src/archon-paths.ts — new path functions follow this pattern:
function getProjectKnowledgePath(owner: string, repo: string): string;
function getGlobalKnowledgePath(): string;
function getKnowledgeLogsPath(owner: string, repo: string): string;
function getKnowledgeDomainsPath(owner: string, repo: string): string;

// packages/core/src/config/config-types.ts — new config section:
interface KnowledgeConfig {
  enabled?: boolean;              // default: true
  captureModel?: string;          // default: 'haiku'
  compileModel?: string;          // default: 'sonnet'
  flushDebounceMinutes?: number;  // default: 10
  domains?: string[];             // default: ['architecture', 'decisions', 'patterns', 'lessons', 'connections']
}

// packages/core/src/services/ — new service interfaces:
interface KnowledgeCaptureReport {
  logsCreated: string[];
  errors: { conversationId: string; error: string }[];
}

interface KnowledgeFlushReport {
  articlesCreated: number;
  articlesUpdated: number;
  articlesStale: number;
  domainsCreated: string[];
}

// packages/core/src/db/messages.ts — existing, used for capture source:
// listMessages(conversationId, limit=200): Promise<readonly MessageRow[]>

// packages/workflows/src/event-emitter.ts — existing event types to extend
// WorkflowEmitterEvent union type (lines 27-160)

// packages/core/src/state/session-transitions.ts — existing triggers:
// TransitionTrigger = 'first-message' | 'plan-to-execute' | 'isolation-changed' | 'reset-requested' | 'worktree-removed' | 'conversation-closed'
```

### Architecture Notes
- **Two-tier KB**: Per-project (`~/.archon/workspaces/owner/repo/knowledge/`) and global (`~/.archon/knowledge/`). Project overrides global (matches config.yaml precedence).
- **Hierarchical indexes**: `index.md` → domain `_index.md` → concept articles. Agent navigates like a wiki.
- **Model usage**: Haiku for capture (fast, cheap, mechanical), Sonnet for compile (quality synthesis), conversation model for query (no extra LLM call).
- **Flush atomicity**: Write to temp files, atomic rename. Crash-safe — next flush re-runs from scratch (idempotent).
- **Flush locking**: File lock at `knowledge/meta/flush.lock` with PID. One concurrent flush per project.
- **Model infrastructure**: Uses existing `IAssistantClient` factory — no direct API calls. Falls back to available model if preferred unavailable.
- **Obsidian compatibility**: Standard markdown with `[[wikilink]]` backlinks between articles.
- **Capture triggers**: `conversation-closed` and `reset-requested` session transitions (NOT `isolation-changed`).
- **KB not in git**: Lives in `~/.archon/` directory (user-specific, not repo-specific).

### Knowledge Base Directory Structure
```
knowledge/
├── index.md                    # Top-level index (loaded at session start)
├── meta/
│   ├── last-flush.json         # { timestamp, gitSha, logsCaptured }
│   └── schema.md               # KB structure description for the agent
├── logs/
│   └── YYYY-MM-DD.md           # Daily capture logs (raw extraction)
└── domains/
    ├── architecture/
    │   ├── _index.md            # Domain index
    │   └── {concept}.md         # Concept articles
    ├── decisions/
    │   ├── _index.md
    │   └── {concept}.md
    ├── patterns/
    │   ├── _index.md
    │   └── {concept}.md
    ├── lessons/
    │   ├── _index.md
    │   └── {concept}.md
    └── connections/
        ├── _index.md
        └── {concept}.md
```

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | Add knowledge path resolution functions | 1 | — |
| US-002 | Add knowledge config types | 1 | — |
| US-003 | Create knowledge directory initialization | 2 | US-001 |
| US-004 | Create KB meta templates (schema.md, index structure) | 3 | US-003 |
| US-005 | Implement capture service (transcript → daily log) | 4 | US-001, US-002 |
| US-006 | Wire capture triggers to session transitions | 5 | US-005 |
| US-007 | Inject knowledge index into prompt builder | 4 | US-001 |
| US-008 | Implement fresh log fallback for unprocessed logs | 5 | US-007 |
| US-009 | Implement compile/flush service (daily logs → articles) | 6 | US-005 |
| US-010 | Implement flush locking and atomicity | 7 | US-009 |
| US-011 | Implement staleness validation in flush | 7 | US-009 |
| US-012 | Implement debounced flush trigger | 8 | US-010 |
| US-013 | Implement global KB tier with precedence | 8 | US-009 |
| US-014 | Add `knowledge flush` CLI command | 9 | US-009 |
| US-015 | Add `knowledge status` CLI command | 9 | US-003 |
| US-016 | Add `knowledge lint` CLI command | 9 | US-011 |
| US-017 | Add engine-level post-workflow capture | 10 | US-005 |
| US-018 | Update default workflows with KB awareness | 11 | US-007, US-017 |
| US-019 | Update workflow builder for KB awareness | 12 | US-018 |
| US-020 | Add explicit knowledge-extract node type | 12 | US-017 |
| US-021 | Add scope field to knowledge-extract nodes (project/global/both) | 13 | US-020, US-013 |
| US-022 | Scoped extraction routing (project log, global log, or both) | 13 | US-021 |
| US-023 | Global synthesis prompt (codebase-agnostic, Sources, contradictions) | 13 | US-013 |
| US-024 | Knowledge correction workflow (archon-knowledge-correct) | 13 | US-013 |

### Dependency Graph
```
US-001 (paths) ─┬─ US-003 (dir init) ── US-004 (templates)
                 │       │
US-002 (config) ─┤       │
                 │       ├── US-015 (CLI status)
                 │       │
                 ├── US-005 (capture service) ── US-006 (trigger wiring)
                 │       │                            │
                 │       ├── US-009 (compile) ─┬── US-010 (locking) ── US-012 (debounce)
                 │       │                     ├── US-011 (staleness) ── US-016 (CLI lint)
                 │       │                     ├── US-013 (global tier)
                 │       │                     └── US-014 (CLI flush)
                 │       │
                 │       └── US-017 (engine capture) ── US-020 (extract nodes)
                 │                    │
                 └── US-007 (prompt inject) ── US-008 (log fallback)
                              │
                              └── US-018 (default workflows) ── US-019 (workflow builder)
```

---

## Validation Requirements

Every story must pass:
- [ ] Type-check: `bun run type-check`
- [ ] Lint: `bun run lint`
- [ ] Tests: `bun run test`
- [ ] Format: `bun run format:check`

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| No vector DB / embeddings / RAG | Markdown + hierarchical indexes | Karpathy's insight: LLMs navigate markdown indexes effectively. Simpler, auditable, git-friendly. |
| Two-tier KB (project + global) | Per-project overrides global | Matches existing config.yaml precedence pattern. |
| Capture model: Haiku | Fast, cheap for structured summarization | High-frequency, mechanical extraction from transcripts. |
| Compile model: Sonnet | Quality-critical synthesis | Lower-frequency, requires judgment for merging concepts. |
| Engine-level implicit capture | Knowledge extraction as engine behavior | Simpler than per-workflow config. Explicit nodes available for richer extraction. |
| Flush trigger: event-based with debounce | ~10min debounce per project | Avoids redundant flushes while keeping KB fresh. |
| File-based flush lock | `knowledge/meta/flush.lock` | Simplest option for single-developer, single-machine use case. |
| Capture triggers | `conversation-closed` + `reset-requested` | NOT `isolation-changed`. Reset is ending a line of work. |
| KB not in git | `~/.archon/` directory | User-specific, not project-specific. Avoids polluting repo. |
| Scope classification in extraction | AI classifies as PROJECT/GLOBAL with project fallback | Conservative default prevents low-quality global entries. |
| Global synthesis prompt | Codebase-agnostic with Sources + Contradictions sections | Global articles must generalize; contradiction detection surfaces conflicting claims across projects. |
| Knowledge correction workflow | AI-mediated with approval gate | User review before destructive operations (delete/merge) — matches interactive-prd pattern. |
| Flush atomicity | Write to temp files, atomic rename | Crash-safe, idempotent — next flush re-runs from scratch. |
| Obsidian compatibility | Standard markdown with `[[wikilinks]]` | KB browsable in Obsidian with graph view. No special tooling needed. |

---

*Generated: 2026-04-11T00:00:00Z*
