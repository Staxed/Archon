mod local_pty;
mod log_path;
mod logger;
mod ssh_tunnel;

pub fn run() {
    // Must be the first thing: installs the panic hook, so any panic during
    // Tauri init itself still leaves a trace in the rotated log.
    logger::init();
    logger::log_event("info", "lifecycle", "archon-desktop sidecar starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ssh_tunnel::TunnelManager::new())
        .manage(local_pty::PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            ssh_tunnel::ssh_connect,
            ssh_tunnel::ssh_disconnect,
            local_pty::pty_spawn,
            local_pty::pty_write,
            local_pty::pty_resize,
            local_pty::pty_kill,
            log_path::get_log_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
