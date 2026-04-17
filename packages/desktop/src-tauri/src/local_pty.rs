use base64::Engine as _;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Managed state holding active local PTY instances
pub struct PtyManager {
    ptys: Mutex<HashMap<String, PtyState>>,
}

struct PtyState {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    /// Handle to the reader thread so we can signal shutdown
    _reader_running: Arc<Mutex<bool>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        if let Ok(mut ptys) = self.ptys.lock() {
            for (_, state) in ptys.drain() {
                // Signal reader threads to stop
                if let Ok(mut running) = state._reader_running.lock() {
                    *running = false;
                }
                // Drop writer and master to close the PTY
                drop(state.writer);
                drop(state.master);
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SpawnResult {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
}

/// Get the default shell for the current platform
pub fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "pwsh".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "zsh".to_string()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "bash".to_string()
    }
}

#[tauri::command]
pub fn pty_spawn(
    cwd: Option<String>,
    command: Option<String>,
    app: AppHandle,
    manager: State<'_, PtyManager>,
) -> Result<SpawnResult, String> {
    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = command.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);

    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command '{}': {}", shell, e))?;

    // Drop the slave side — we only need the master
    drop(pair.slave);

    let pty_id = Uuid::new_v4().to_string();
    let event_name = format!("pty:output:{}", pty_id);

    // Get a reader from the master for the output stream
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Get a writer for input
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Flag to signal the reader thread to stop
    let reader_running = Arc::new(Mutex::new(true));
    let reader_running_clone = Arc::clone(&reader_running);

    // Spawn a background thread to read PTY output and emit events
    let app_clone = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            // Check if we should stop
            if let Ok(running) = reader_running_clone.lock() {
                if !*running {
                    break;
                }
            }

            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_clone.emit(&event_name, encoded);
                }
                Err(e) => {
                    crate::logger::log_event(
                        "error",
                        "local_pty",
                        &format!("reader err: {}", e),
                    );
                    break;
                }
            }
        }
    });

    // Store PTY state
    {
        let mut ptys = manager.ptys.lock().map_err(|e| e.to_string())?;
        ptys.insert(
            pty_id.clone(),
            PtyState {
                writer,
                master: pair.master,
                _reader_running: reader_running,
            },
        );
    }

    Ok(SpawnResult { pty_id })
}

#[tauri::command]
pub fn pty_write(
    pty_id: String,
    bytes: String, // base64-encoded bytes
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&bytes)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let mut ptys = manager.ptys.lock().map_err(|e| e.to_string())?;
    let state = ptys
        .get_mut(&pty_id)
        .ok_or_else(|| format!("No PTY with id '{}'", pty_id))?;

    state
        .writer
        .write_all(&decoded)
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;

    state
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    pty_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let ptys = manager.ptys.lock().map_err(|e| e.to_string())?;
    let state = ptys
        .get(&pty_id)
        .ok_or_else(|| format!("No PTY with id '{}'", pty_id))?;

    state
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_kill(pty_id: String, manager: State<'_, PtyManager>) -> Result<(), String> {
    let mut ptys = manager.ptys.lock().map_err(|e| e.to_string())?;
    let state = ptys
        .remove(&pty_id)
        .ok_or_else(|| format!("No PTY with id '{}'", pty_id))?;

    // Signal reader thread to stop
    if let Ok(mut running) = state._reader_running.lock() {
        *running = false;
    }

    // Dropping writer and master closes the PTY
    drop(state.writer);
    drop(state.master);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_shell_windows() {
        // On Windows, default shell should be pwsh
        #[cfg(target_os = "windows")]
        {
            assert_eq!(default_shell(), "pwsh");
        }
    }

    #[test]
    fn test_default_shell_macos() {
        // On macOS, default shell should be zsh
        #[cfg(target_os = "macos")]
        {
            assert_eq!(default_shell(), "zsh");
        }
    }

    #[test]
    fn test_default_shell_linux_fallback() {
        // On Linux (or any non-Windows/macOS), default shell should be bash
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            assert_eq!(default_shell(), "bash");
        }
    }

    #[test]
    fn test_default_shell_returns_nonempty() {
        let shell = default_shell();
        assert!(!shell.is_empty(), "Default shell should not be empty");
    }

    #[test]
    fn test_pty_manager_new() {
        let manager = PtyManager::new();
        let ptys = manager.ptys.lock().unwrap();
        assert!(ptys.is_empty(), "New PtyManager should have no PTYs");
    }
}
