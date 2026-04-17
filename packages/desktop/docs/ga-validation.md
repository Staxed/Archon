# GA Validation Checklist

**Date:** 2026-04-17
**Validator:** Automated build (code-verified); manual smoke tests required before GA ship.

---

## Primary Success Metrics (PRD Section 6)

| # | Metric | Status | Evidence |
|---|--------|--------|----------|
| 1 | **Zero lost remote work on workstation reboot** | Code-verified | Every remote pane is tmux-backed (`tmux new-session -A`). Reconnection banner (US-031) auto-retries with exponential backoff. Host Sessions panel (US-018) lists detached sessions for reattach. |
| 2 | **One-click multi-terminal launch** | Code-verified | `launchProfile(id)` in `ProfileLauncher.ts` resolves panes, allocates grid slots, creates tmux sessions with attach-if-exists semantics. Profile editor (US-020) persists profiles to JSON. |
| 3 | **Additive profile launching** | Code-verified | `computeLaunchPanes()` takes existing grid panes as input and places new panes in free slots. Over-cap warning when total > 18 slots. Unit tests verify additive behavior (US-021). |
| 4 | **Cursor fully retired** | Pending manual validation | All Must-have features implemented. Operator must confirm Cursor is no longer launched after routine use. |
| 5 | **Parity across Windows and macOS** | Code-verified (see matrix below) | Platform branches verified in code for shell defaults, Reveal-in-OS, app-data paths, log paths, installer builds. |

---

## Must-Have Feature Test Matrix (PRD Section 9)

### Legend

- **Code**: Verified via code inspection and unit tests
- **Manual-Win**: Requires manual verification on Windows
- **Manual-Mac**: Requires manual verification on macOS

| Area | Feature | Windows | macOS | Notes |
|------|---------|---------|-------|-------|
| **Shell** | Tauri v2 cross-platform app | Code | Code | Tauri v2 config targets both (US-001, US-034) |
| **Shell** | Dark theme only | Code | Code | CSS variables in `styles.css`, no theme picker (US-004) |
| **Remoting** | SSH bootstrap via `~/.ssh/config` | Code | Code | `ssh_tunnel.rs` shells out to system `ssh` (US-003) |
| **Remoting** | Port-forward to localhost | Code | Code | Deterministic port `hash % 900 + 4200` range 4200-5099 (US-003) |
| **Remoting** | Auto-reconnect on drops | Code | Code | Exponential backoff 1s/2s/4s/8s/16s, manual Reconnect button (US-031) |
| **File tree** | Unified tree with host badges | Code | Code | `FileTree.tsx` with remote/local badges (US-013) |
| **File tree** | Archon codebase badge | Code | Code | `matchesCodebasePath` checks against `/api/codebases` (US-015) |
| **File tree** | Context menu (New File/Folder, Copy Path, etc.) | Code | Code | 6 menu actions implemented (US-013) |
| **File tree** | Add Folder to Workspace | Code | Code | Modal with host picker and path browser (US-014) |
| **File tree** | Reveal in OS | Code | Code | `getRevealCommand`: `explorer.exe /select,` (Win) / `open -R` (Mac) (US-016) |
| **File tree** | Open Archon Web UI | Code | Code | Opens browser via Tauri shell.open (US-016) |
| **Terminal grid** | 3x6 = 18 slots | Code | Code | `react-grid-layout` with `cols: 6, maxRows: 3` (US-010) |
| **Terminal grid** | Resize + snap + drag-rearrange | Code | Code | Grid reducer with MOVE/RESIZE/LAYOUT_CHANGE (US-010) |
| **Terminal grid** | xterm.js + WebGL + fit | Code | Code | `TerminalPane.tsx` with addon-webgl + addon-fit (US-008) |
| **Terminal grid** | OSC 133 command blocks | Code | Code | `Osc133Addon.ts` parses A/B/C/D sequences (US-009) |
| **Local PTYs** | `pwsh` on Windows | Code | N/A | `default_shell()` in `local_pty.rs`: `#[cfg(target_os = "windows")]` returns `"pwsh"` |
| **Local PTYs** | `zsh` on macOS | N/A | Code | `default_shell()` in `local_pty.rs`: `#[cfg(target_os = "macos")]` returns `"zsh"` |
| **Remote PTYs** | tmux-wrapped shells | Code | Code | Server-side `tmux new-session -A` via PTY WS endpoint (US-007) |
| **Remote PTYs** | Deterministic session naming | Code | Code | `archon-desktop:{profileSlug}:{paneSlug}` pattern (US-021) |
| **Pane close** | Default = detach tmux | Code | Code | Close button detaches; right-click for Kill (US-010) |
| **Host Sessions** | Panel with Attach/Kill/Rename | Code | Code | Auto-refresh 15s, drag-to-grid (US-018) |
| **Ad-hoc terminals** | Open Terminal Here | Code | Code | `openAdHocTerminal` with `adhoc:<uuid>` naming (US-011) |
| **Launch Profiles** | JSON persistence + editor | Code | Code | Zod schemas, CRUD helpers, editor UI (US-019, US-020) |
| **Launch Profiles** | Additive launching | Code | Code | `computeLaunchPanes` preserves existing grid (US-021) |
| **Agent launchers** | 8 presets (Claude/Codex/Gemini/OR/Llama) | Code | Code | `DEFAULT_PRESETS` in `AgentPresets.ts` (US-022) |
| **Agent launchers** | {MODEL} prompt + YOLO red border | Code | Code | `AgentLauncherDropdown.tsx` (US-023) |
| **Agent launchers** | aichat config auto-generation | Code | Code | `POST /api/desktop/aichat/ensure-config` (US-024) |
| **Editor column** | Collapsible + snap widths | Code | Code | `EditorColumn.tsx` with 1x/2x/3x snap (US-025) |
| **Editor backend** | CodeMirror 6 + LSP-over-the-wire | Code | Code | CM6 chosen over Monaco after spike (US-030) |
| **Editor** | Tabs (preview/pinned) + dirty indicator | Code | Code | Tab state machine in `EditorTabs.ts` (US-026) |
| **Editor** | Split-right | Code | Code | `SplitState` + `SPLIT_RIGHT` action (US-029) |
| **File I/O** | Atomic read/write + conflict detection | Code | Code | `PUT /api/desktop/fs/file` with expectedMtime (US-027, US-028) |
| **Preflight** | Dependency check + banner | Code | Code | `GET /api/desktop/preflight` + `PreflightBanner.tsx` (US-005) |
| **Error handling** | Classified errors (SSH/tmux/LSP/file/port) | Code | Code | `classifyDesktopError` in `lib/errors.ts` (US-032) |
| **Logging** | 10 MB rotation, per-OS path | Code | Code | `lib/logger.ts` + `log_path.rs` (US-033) |
| **Installers** | Windows MSI | Code | N/A | `tauri.conf.json` bundle config (US-034) |
| **Installers** | macOS DMG + notarization | N/A | Code | Signing via env vars documented in README (US-034) |

---

## Platform-Specific Branch Verification

### Shell defaults

| Platform | Expected | Actual (code) | File | Status |
|----------|----------|---------------|------|--------|
| Windows | `pwsh` | `"pwsh".to_string()` | `src-tauri/src/local_pty.rs:57` | Verified |
| macOS | `zsh` | `"zsh".to_string()` | `src-tauri/src/local_pty.rs:61` | Verified |
| Linux (fallback) | `bash` | `"bash".to_string()` | `src-tauri/src/local_pty.rs:65` | Verified |

### Reveal-in-OS

| Platform | Expected | Actual (code) | File | Status |
|----------|----------|---------------|------|--------|
| Windows | `explorer.exe /select,<path>` | `{ command: 'explorer.exe', args: ['/select,' + filePath] }` | `src/FileTree.tsx:101` | Verified |
| macOS | `open -R <path>` | `{ command: 'open', args: ['-R', filePath] }` | `src/FileTree.tsx:104` | Verified |
| Remote | No-op toast | Returns `null`, toast shown | `src/FileTree.tsx:106` | Verified |

### App-data paths

| Platform | Expected | Actual (code) | Status |
|----------|----------|---------------|--------|
| Windows | `%APPDATA%\ArchonDesktop\` | Logs: `${appDataDir}\ArchonDesktop\logs` (logger.ts), Profiles/Agents/Workspace: localStorage (Tauri fs API in production) | Verified |
| macOS | `~/Library/Application Support/ArchonDesktop/` | Logs: `${homeDir}/Library/Logs/ArchonDesktop` (logger.ts), Profiles/Agents/Workspace: localStorage (Tauri fs API in production) | Verified |

### Log paths (Rust side)

| Platform | Expected | Actual (code) | File | Status |
|----------|----------|---------------|------|--------|
| Windows | `%APPDATA%\ArchonDesktop\logs` | `format!("{}\\ArchonDesktop\\logs", appdata)` | `src-tauri/src/log_path.rs:17` | Verified |
| macOS | `~/Library/Logs/ArchonDesktop` | `format!("{}/Library/Logs/ArchonDesktop", home)` | `src-tauri/src/log_path.rs:24` | Verified |

---

## Aqua Voice Smoke Test

**Status:** Pending manual validation

**Assumption (from PRD Section 10.5/10.11):** Aqua Voice uses OS-level keystroke injection into the focused window. `xterm.js` handles standard keyboard input natively, so dictation into a focused terminal pane should work without custom integration.

**Fallback:** If Aqua Voice uses clipboard-paste instead of keystroke injection, xterm.js supports paste events by default. Verify paste-into-xterm works on both platforms.

**Test plan:**
1. Focus a terminal pane running a shell
2. Activate Aqua Voice dictation
3. Speak a command (e.g., "echo hello world")
4. Verify text appears in the terminal
5. Repeat on both Windows and macOS

---

## G9 Ultrawide Validation (5120x1440)

**Status:** Pending manual validation

**Test plan:**
1. Open Archon Desktop on the 57" Samsung G9 at 5120x1440
2. Launch a profile with 18 panes (3x6 grid fully occupied)
3. Verify all panes render without overlap or clipping
4. Verify xterm.js WebGL rendering is smooth (no flickering, no dropped frames)
5. Verify grid resize handles are accessible at each pane boundary
6. Repeat on macOS display

---

## Manual Smoke Test Checklist

Before GA ship, the operator should execute the following on both Windows and macOS:

- [ ] Install via MSI (Windows) / DMG (macOS)
- [ ] App launches without Gatekeeper warnings (macOS)
- [ ] SSH connects to primary Linux host
- [ ] Preflight banner shows any missing dependencies
- [ ] File tree loads remote root via `/api/desktop/fs/tree`
- [ ] Open a file in the editor; verify syntax highlighting
- [ ] Ctrl+S saves; conflict detection works on concurrent edit
- [ ] Open 4+ terminal panes; verify xterm.js renders
- [ ] Reboot workstation; reopen app; reattach to running tmux sessions
- [ ] Launch a saved profile; verify all panes open additively
- [ ] Agent launcher starts Claude in a pane
- [ ] YOLO preset shows red border on pane header
- [ ] Host Sessions panel lists tmux sessions; Attach/Kill/Rename work
- [ ] Reveal in OS opens Explorer (Windows) / Finder (macOS)
- [ ] Aqua Voice dictation into a focused terminal pane
- [ ] 18-pane grid on G9 ultrawide (Windows)

---

## Validation Summary

| Category | Status |
|----------|--------|
| Code completeness | All 35 user stories implemented and passing |
| Unit tests | All passing (`bun run test`) |
| Type safety | Clean (`bun run type-check`) |
| Lint | Zero warnings (`bun run lint`) |
| Platform branches | All verified via code inspection |
| Manual smoke tests | Pending (requires Windows + macOS hardware) |
| Aqua Voice | Pending manual test |
| G9 ultrawide | Pending manual test |
