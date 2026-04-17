# Editor Backend Decision: CodeMirror 6 with LSP-over-the-wire

**Date:** 2026-04-17
**Status:** Decided — CM6 selected
**Context:** PRD §10.7 / §12 Phase 6 mandated a 2-day spike to determine whether CodeMirror 6 could support LSP-over-the-wire for remote language servers, with Monaco as the fallback.

## Decision

**CodeMirror 6 is the editor backend.** The CM6 LSP integration works cleanly via `codemirror-languageserver` and a WebSocket proxy endpoint.

## Spike Summary

The `codemirror-languageserver` package (v1.22) provides a `languageServer()` function that accepts a WebSocket URI and returns CM6 extensions for completion, hover, diagnostics, go-to-definition, document highlights, and rename support. The library handles LSP JSON-RPC framing internally.

**Architecture:**

1. Server: `WS /api/desktop/lsp?language=&projectDir=` spawns the appropriate language server process (e.g., `typescript-language-server --stdio`) and relays JSON-RPC bidirectionally between the WebSocket and the LS process stdin/stdout.
2. Client: `codemirror-languageserver`'s `languageServer()` is added as a CM6 extension at editor creation time, connecting to the WS endpoint with the correct language and project dir.
3. Connection reuse: The server maintains a map of active language server processes keyed by `language:projectDir`. Multiple editor tabs for files in the same project reuse the same LS process. Reference counting ensures cleanup when the last tab disconnects.

**Supported language servers:**

- TypeScript/JavaScript: `typescript-language-server --stdio`
- Python: `pylsp`
- Go: `gopls serve`
- Rust: `rust-analyzer`
- Markdown: `marksman server`

**Fail-fast behavior:**

- Missing language server on the remote host: LSP features are silently disabled for that language. The editor works normally without LSP (syntax highlighting from CM6 language packs still applies).
- Unsupported file type: No LSP extensions added; editor functions as before.
- WebSocket connection failure: `codemirror-languageserver` handles this internally; the editor degrades gracefully.

## Why Not Monaco

Monaco was the fallback per PRD §7.1. The spike determined that CM6 + `codemirror-languageserver` covers the required LSP features (hover, completion, diagnostics, go-to-definition) without the significant bundle size increase of Monaco (~4 MB vs ~200 KB for CM6 LSP additions). The CM6 approach also preserves the existing tab/dirty/save architecture unchanged.

## Trade-offs

- **Pro:** Smaller bundle, simpler integration, React-friendly, existing tab architecture preserved.
- **Con:** CM6 LSP ecosystem is less mature than Monaco's built-in LSP support. Some edge cases (e.g., multi-root workspaces, semantic tokens) may require additional work in the future.
- **Mitigation:** The `codemirror-languageserver` library is actively maintained and covers the must-have features from the PRD.
