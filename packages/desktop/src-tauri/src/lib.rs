mod local_pty;
mod log_path;
mod ssh_tunnel;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
