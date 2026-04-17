//! Rust-side rotated file logger for the Archon Desktop sidecar.
//!
//! Matches the TypeScript frontend logger (`packages/desktop/src/lib/logger.ts`):
//! writes NDJSON records to `<app-data>/logs/archon-desktop.log` and rotates
//! to `archon-desktop.log.1` when the file exceeds 10 MB.
//!
//! This is the only place Rust-side events (SSH tunnel failures, PTY crashes,
//! panics) land on disk — without it those events are lost.

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Max log file size before rotation — mirrors the TS frontend (10 MB).
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Log file name — same as `log_path.rs::LOG_FILENAME`.
const LOG_FILENAME: &str = "archon-desktop.log";

/// Global logger state.
///
/// `OnceLock` ensures `init` runs exactly once; the `Mutex` serializes
/// concurrent writes from the SSH tunnel, PTY manager, and panic hook.
static LOGGER: OnceLock<Mutex<LoggerState>> = OnceLock::new();

struct LoggerState {
    path: PathBuf,
}

/// Structured log event — serialized as one JSON line per write.
#[derive(Serialize)]
struct LogRecord<'a> {
    ts: u128,
    level: &'a str,
    source: &'a str,
    msg: &'a str,
}

/// Resolve the platform-specific log directory.
///
/// Duplicates `log_path::get_log_dir` intentionally — that function is private
/// to its module, and re-exporting it would leak the internal `Option<String>`
/// shape into `lib.rs`. This keeps each module self-contained.
fn resolve_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|appdata| PathBuf::from(format!("{}\\ArchonDesktop\\logs", appdata)))
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(|home| {
            if cfg!(target_os = "macos") {
                PathBuf::from(format!("{}/Library/Logs/ArchonDesktop", home))
            } else {
                PathBuf::from(format!("{}/.local/share/ArchonDesktop/logs", home))
            }
        })
    }
}

/// Initialize the logger. Creates the log directory if missing and installs
/// a panic hook so unexpected crashes leave a trace. Safe to call multiple
/// times — subsequent calls are no-ops.
pub fn init() {
    if LOGGER.get().is_some() {
        return;
    }

    let Some(dir) = resolve_log_dir() else {
        // No HOME/APPDATA — fall back silently. Logging without a target dir
        // has no way to succeed; callers get a no-op.
        return;
    };

    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[archon-desktop] failed to create log dir {:?}: {}", dir, e);
        return;
    }

    let path = dir.join(LOG_FILENAME);
    let _ = LOGGER.set(Mutex::new(LoggerState { path: path.clone() }));

    // Panic hook — logs the panic payload before the process aborts.
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                info.payload()
                    .downcast_ref::<String>()
                    .map(|s| s.as_str())
            })
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let full = format!("{} at {}", msg, location);
        log_event("error", "panic", &full);
    }));
}

/// Rotate the log file if it has exceeded `MAX_LOG_BYTES`.
///
/// Rename rather than truncate so callers can still inspect recent history
/// in `archon-desktop.log.1`. Silent on failure — a broken rotation must not
/// break the app.
fn rotate_if_needed(path: &PathBuf) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_LOG_BYTES {
        return;
    }
    let rotated = path.with_extension("log.1");
    // Overwrite any existing .1 — we only keep one rotation.
    let _ = fs::remove_file(&rotated);
    let _ = fs::rename(path, &rotated);
}

/// Write a log event as one NDJSON line. Silent on I/O failure.
pub fn log_event(level: &str, source: &str, msg: &str) {
    let Some(state) = LOGGER.get() else {
        return;
    };
    let Ok(state) = state.lock() else {
        return;
    };

    rotate_if_needed(&state.path);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let record = LogRecord {
        ts,
        level,
        source,
        msg,
    };
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&state.path) else {
        return;
    };
    let _ = writeln!(file, "{}", line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_log_bytes_matches_ts_frontend() {
        assert_eq!(MAX_LOG_BYTES, 10 * 1024 * 1024);
    }

    #[test]
    fn log_filename_matches_log_path_module() {
        assert_eq!(LOG_FILENAME, "archon-desktop.log");
    }

    #[test]
    fn rotate_renames_oversized_file() {
        let dir = std::env::temp_dir().join(format!("archon-desktop-logger-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rotate-test.log");

        // Write > 10 MB.
        let mut f = fs::File::create(&path).unwrap();
        let chunk = vec![b'x'; 1024 * 1024]; // 1 MiB
        for _ in 0..11 {
            f.write_all(&chunk).unwrap();
        }
        drop(f);

        rotate_if_needed(&path);

        assert!(!path.exists(), "original log should be rotated away");
        assert!(path.with_extension("log.1").exists(), ".1 rotation should exist");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_leaves_small_file_alone() {
        let dir = std::env::temp_dir().join(format!("archon-desktop-logger-small-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small.log");
        fs::write(&path, b"only a few bytes").unwrap();

        rotate_if_needed(&path);

        assert!(path.exists(), "small log should be left alone");
        assert!(!path.with_extension("log.1").exists(), "no rotation expected");

        let _ = fs::remove_dir_all(&dir);
    }
}
