use serde::Serialize;

/// Log file name
const LOG_FILENAME: &str = "archon-desktop.log";

#[derive(Serialize)]
pub struct LogPathResult {
    pub path: String,
    pub dir: String,
}

/// Get the platform-specific log directory.
fn get_log_dir() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|appdata| format!("{}\\ArchonDesktop\\logs", appdata))
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(|home| {
            if cfg!(target_os = "macos") {
                format!("{}/Library/Logs/ArchonDesktop", home)
            } else {
                format!("{}/.local/share/ArchonDesktop/logs", home)
            }
        })
    }
}

/// Tauri command: return the log file path for Settings → About → Open Logs.
#[tauri::command]
pub fn get_log_path() -> Result<LogPathResult, String> {
    let dir = get_log_dir().ok_or_else(|| "Could not determine log directory".to_string())?;

    let sep = if cfg!(target_os = "windows") {
        "\\"
    } else {
        "/"
    };
    let path = format!("{}{}{}", dir, sep, LOG_FILENAME);

    Ok(LogPathResult { path, dir })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_log_path_returns_result() {
        let result = get_log_path();
        assert!(result.is_ok());
        let log = result.unwrap();
        assert!(log.path.contains(LOG_FILENAME));
        assert!(!log.dir.is_empty());
    }

    #[test]
    fn log_filename_is_correct() {
        assert_eq!(LOG_FILENAME, "archon-desktop.log");
    }
}
