use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::timeout;

/// Default remote Archon server port
const DEFAULT_REMOTE_PORT: u16 = 3090;

/// Timeout for waiting on the local port to accept connections
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Managed state holding active SSH tunnel processes
pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelState>>,
}

struct TunnelState {
    child: Child,
    local_port: u16,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
        }
    }
}

impl Drop for TunnelManager {
    fn drop(&mut self) {
        if let Ok(mut tunnels) = self.tunnels.lock() {
            for (_, mut state) in tunnels.drain() {
                // Best-effort kill on app exit
                let _ = state.child.start_kill();
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    #[serde(rename = "localPort")]
    pub local_port: u16,
}

/// Compute a deterministic local port from the host alias.
/// Formula: hash('archon-desktop:' + hostAlias) % 900 + 4200
/// Range: 4200-5099 (non-overlapping with worktree range 3190-4089)
pub fn compute_local_port(host_alias: &str) -> u16 {
    let key = format!("archon-desktop:{}", host_alias);
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    let hash = hasher.finish();
    (hash % 900 + 4200) as u16
}

/// Classify SSH stderr output into user-facing error messages
pub fn classify_ssh_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();

    if lower.contains("host key verification failed") {
        return "SSH host key verification failed. Run `ssh-keygen -R <host>` to remove the old key, then retry.".to_string();
    }
    if lower.contains("permission denied") {
        return "SSH permission denied. Check your SSH key is loaded (`ssh-add -l`) and the remote host accepts it.".to_string();
    }
    if lower.contains("connection refused") {
        return "SSH connection refused. Verify the remote host is running and the SSH port is open.".to_string();
    }
    if lower.contains("no such host") || lower.contains("could not resolve hostname") {
        return "SSH host not found. Check the host alias in ~/.ssh/config and verify DNS resolution.".to_string();
    }
    if lower.contains("connection timed out") || lower.contains("operation timed out") {
        return "SSH connection timed out. Check network connectivity to the remote host.".to_string();
    }
    if lower.contains("address already in use") {
        return "Local port already in use. Close the other Archon Desktop instance or SSH tunnel using this port.".to_string();
    }
    if lower.contains("no such identity")
        || lower.contains("identity file")
            && lower.contains("no such file")
    {
        return "SSH identity file not found. Check your ~/.ssh/config IdentityFile path.".to_string();
    }

    format!("SSH tunnel failed: {}", stderr.trim())
}

#[tauri::command]
pub async fn ssh_connect(
    host_alias: String,
    remote_port: Option<u16>,
    manager: State<'_, TunnelManager>,
) -> Result<ConnectResult, String> {
    let local_port = compute_local_port(&host_alias);
    let remote = remote_port.unwrap_or(DEFAULT_REMOTE_PORT);

    // Check if already connected
    {
        let tunnels = manager.tunnels.lock().map_err(|e| e.to_string())?;
        if let Some(state) = tunnels.get(&host_alias) {
            return Ok(ConnectResult {
                local_port: state.local_port,
            });
        }
    }

    // Spawn ssh -NL <localPort>:127.0.0.1:<remotePort> <hostAlias>
    let forward_spec = format!("{}:127.0.0.1:{}", local_port, remote);

    let mut child = Command::new("ssh")
        .arg("-N")
        .arg("-L")
        .arg(&forward_spec)
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg(&host_alias)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    // Wait for the local port to accept TCP connections (up to 15s)
    let port_ready = wait_for_port(local_port, CONNECT_TIMEOUT).await;

    if !port_ready {
        // Check if the ssh process exited with an error
        let stderr_output = read_child_stderr(&mut child).await;
        let _ = child.start_kill();

        if let Some(stderr) = stderr_output {
            if !stderr.is_empty() {
                return Err(classify_ssh_error(&stderr));
            }
        }

        return Err(format!(
            "SSH tunnel timed out after {}s waiting for local port {} to accept connections.",
            CONNECT_TIMEOUT.as_secs(),
            local_port
        ));
    }

    // Store the tunnel state
    {
        let mut tunnels = manager.tunnels.lock().map_err(|e| e.to_string())?;
        tunnels.insert(
            host_alias,
            TunnelState {
                child,
                local_port,
            },
        );
    }

    Ok(ConnectResult { local_port })
}

#[tauri::command]
pub async fn ssh_disconnect(
    host_alias: String,
    manager: State<'_, TunnelManager>,
) -> Result<(), String> {
    let mut tunnels = manager.tunnels.lock().map_err(|e| e.to_string())?;
    if let Some(mut state) = tunnels.remove(&host_alias) {
        let _ = state.child.start_kill();
        Ok(())
    } else {
        Err(format!("No active tunnel for host '{}'", host_alias))
    }
}

/// Poll TCP connect on localhost:port until success or timeout
async fn wait_for_port(port: u16, dur: Duration) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let poll_interval = Duration::from_millis(200);

    let result = timeout(dur, async {
        loop {
            if TcpStream::connect(&addr).await.is_ok() {
                return true;
            }
            tokio::time::sleep(poll_interval).await;
        }
    })
    .await;

    result.unwrap_or(false)
}

/// Read stderr from the child process (non-blocking, best-effort)
async fn read_child_stderr(child: &mut Child) -> Option<String> {
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = String::new();
        let read_result = timeout(Duration::from_secs(2), stderr.read_to_string(&mut buf)).await;
        match read_result {
            Ok(Ok(_)) => Some(buf),
            _ => None,
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_port_hash_determinism() {
        // Same alias always gives the same port
        let port1 = compute_local_port("linux-beast");
        let port2 = compute_local_port("linux-beast");
        assert_eq!(port1, port2);
    }

    #[test]
    fn test_port_hash_range() {
        // Port must be in range 4200-5099
        let test_hosts = [
            "linux-beast",
            "my-server",
            "dev-box",
            "prod-1",
            "test-host-with-long-name",
            "",
            "a",
        ];
        for host in &test_hosts {
            let port = compute_local_port(host);
            assert!(
                (4200..=5099).contains(&port),
                "Port {} for host '{}' is out of range 4200-5099",
                port,
                host
            );
        }
    }

    #[test]
    fn test_port_hash_different_hosts() {
        // Different aliases should (likely) produce different ports
        let port1 = compute_local_port("host-a");
        let port2 = compute_local_port("host-b");
        // Not guaranteed to differ due to hash collisions, but these specific strings should differ
        assert_ne!(port1, port2);
    }

    #[test]
    fn test_classify_ssh_error_host_key() {
        let msg = classify_ssh_error(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.",
        );
        assert!(msg.contains("host key verification failed"));
        assert!(msg.contains("ssh-keygen -R"));
    }

    #[test]
    fn test_classify_ssh_error_permission_denied() {
        let msg =
            classify_ssh_error("user@host: Permission denied (publickey,keyboard-interactive).");
        assert!(msg.contains("permission denied"));
        assert!(msg.contains("ssh-add"));
    }

    #[test]
    fn test_classify_ssh_error_connection_refused() {
        let msg = classify_ssh_error("ssh: connect to host example.com port 22: Connection refused");
        assert!(msg.contains("connection refused"));
        assert!(msg.contains("SSH port"));
    }

    #[test]
    fn test_classify_ssh_error_no_such_host() {
        let msg = classify_ssh_error("ssh: Could not resolve hostname bad-host: No such host");
        assert!(msg.contains("host not found"));
        assert!(msg.contains("~/.ssh/config"));
    }

    #[test]
    fn test_classify_ssh_error_timeout() {
        let msg = classify_ssh_error("ssh: connect to host slow.example.com: Connection timed out");
        assert!(msg.contains("timed out"));
        assert!(msg.contains("network connectivity"));
    }

    #[test]
    fn test_classify_ssh_error_address_in_use() {
        let msg = classify_ssh_error("bind [127.0.0.1]:4500: Address already in use");
        assert!(msg.contains("already in use"));
    }

    #[test]
    fn test_classify_ssh_error_unknown() {
        let msg = classify_ssh_error("some weird error we haven't seen");
        assert!(msg.starts_with("SSH tunnel failed:"));
        assert!(msg.contains("some weird error"));
    }
}
