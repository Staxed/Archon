mod ssh_tunnel;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ssh_tunnel::TunnelManager::new())
        .invoke_handler(tauri::generate_handler![
            ssh_tunnel::ssh_connect,
            ssh_tunnel::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
