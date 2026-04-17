# Archon Desktop

Cross-platform Tauri v2 desktop application (Windows + macOS) for AI-assisted coding via SSH-tunneled connections to a Linux host.

## Prerequisites

- [Bun](https://bun.sh/) (latest)
- [Rust](https://rustup.rs/) (1.77.2+)
- Platform-specific build tools (see below)

### Windows

- Visual Studio Build Tools with C++ workload
- WebView2 (included in Windows 10/11)

### macOS

- Xcode Command Line Tools (`xcode-select --install`)
- Xcode (for code signing and notarization)

## Development

```bash
# From the repo root
bun install

# Start desktop dev mode (Vite + Tauri hot reload)
cd packages/desktop
bunx tauri dev
```

## Building Installers

### Windows (MSI)

```bash
cd packages/desktop
bunx tauri build
```

The MSI installer is output to `src-tauri/target/release/bundle/msi/`.

### macOS (DMG)

#### Unsigned build (development)

```bash
cd packages/desktop
bunx tauri build
```

The DMG is output to `src-tauri/target/release/bundle/dmg/`.

#### Signed + notarized build (distribution)

Set the following environment variables before building:

```bash
# Code signing identity (from Keychain Access → Developer ID Application certificate)
export APPLE_CERTIFICATE="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_CERTIFICATE_PASSWORD="certificate-p12-password"

# Notarization credentials
export APPLE_ID="your@apple.id"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

Then build:

```bash
cd packages/desktop
bunx tauri build
```

Tauri v2 automatically signs with the `APPLE_CERTIFICATE` identity and submits for notarization using the `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` credentials when those environment variables are set.

After `tauri build` completes, verify notarization and staple the ticket:

```bash
# Check notarization status (should show "Accepted")
xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"

# Staple the notarization ticket to the DMG
xcrun stapler staple src-tauri/target/release/bundle/dmg/Archon\ Desktop_0.1.0_aarch64.dmg
```

## Remote Host Dependencies

The remote Linux host must have the following installed:

```bash
# Required
sudo apt install tmux    # tmux >= 3.0 required for -A flag

# Required for agent presets
cargo install aichat     # For OpenRouter / Llama.cpp presets

# Optional: Language servers (for editor LSP features)
npm i -g typescript-language-server typescript
pip install python-lsp-server
go install golang.org/x/tools/gopls@latest
# rust-analyzer: installed via rustup component add rust-analyzer
# marksman: see https://github.com/artempyanykh/marksman/releases
```

## Troubleshooting

### SSH connection failures

- **Host key verification failed**: Run `ssh-keygen -R <hostname>` then reconnect.
- **Permission denied (publickey)**: Verify your SSH key is loaded (`ssh-add -l`) and the public key is in `~/.ssh/authorized_keys` on the remote.
- **Connection refused**: Ensure `sshd` is running on the remote host.

### tmux issues

- **tmux version < 3.0**: Upgrade tmux (`sudo apt install tmux` or build from source). Version 3.0+ is required for `-A` flag support.
- **tmux binary missing**: Install via `sudo apt install tmux`.

### Port collisions

- **Port in use**: Archon Desktop uses ports 4200-5099. Archon worktrees use 3190-4089. If you see a port conflict, close the other Archon instance or specify `PORT=<number>` to override.
- **Multiple desktop instances**: Each SSH host alias gets a deterministic port. Two instances connecting to the same host will collide.

## Architecture

See the [PRD](../../.archon/ralph/archon-desktop/prd.md) for full architecture details.

- `src/` — React + TypeScript renderer (Vite)
- `src-tauri/` — Rust host code (SSH tunnel, local PTY, log paths)
- Server endpoints live in `packages/server/src/routes/desktop.ts`
