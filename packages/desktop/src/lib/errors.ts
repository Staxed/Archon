/**
 * Fail-fast error classifiers for Archon Desktop.
 *
 * Mirrors the `classifyIsolationError` pattern from `@archon/isolation`.
 * Maps raw error messages to human-friendly strings with fix hints.
 */

export type ErrorCategory = 'ssh' | 'tmux' | 'lsp' | 'file' | 'port';

interface ErrorPattern {
  pattern: string;
  message: string;
}

const SSH_PATTERNS: ErrorPattern[] = [
  {
    pattern: 'host key verification failed',
    message:
      'SSH host key verification failed. Run `ssh-keygen -R <host>` to remove the old key, then retry.',
  },
  {
    pattern: 'permission denied (publickey)',
    message:
      'SSH authentication failed (publickey). Check that your SSH key is loaded in ssh-agent or 1Password SSH agent.',
  },
  {
    pattern: 'permission denied',
    message: 'SSH permission denied. Verify your SSH key is loaded and the remote user has access.',
  },
  {
    pattern: 'connection refused',
    message: 'SSH connection refused. Verify the remote host is running and the SSH port is open.',
  },
  {
    pattern: 'no such host',
    message: 'SSH host not found. Check the hostname in `~/.ssh/config` or verify DNS resolution.',
  },
  {
    pattern: 'could not resolve hostname',
    message:
      'SSH hostname could not be resolved. Check your network connection and `~/.ssh/config`.',
  },
  {
    pattern: 'connection timed out',
    message:
      'SSH connection timed out. Check your network connection and that the remote host is reachable.',
  },
  {
    pattern: 'operation timed out',
    message:
      'SSH connection timed out. Check your network connection and that the remote host is reachable.',
  },
  {
    pattern: 'network is unreachable',
    message: 'Network is unreachable. Check your internet connection.',
  },
];

const TMUX_PATTERNS: ErrorPattern[] = [
  {
    pattern: 'command not found',
    message: 'tmux is not installed on the remote host. Install with: `sudo apt install tmux`',
  },
  {
    pattern: 'no such file or directory',
    message: 'tmux binary not found on the remote host. Install with: `sudo apt install tmux`',
  },
  {
    pattern: 'session name invalid',
    message: 'Invalid tmux session name. Session names must match `archon-desktop:[a-z0-9:-]+`.',
  },
  {
    pattern: 'protocol version mismatch',
    message: 'tmux version mismatch between client and server. Try `tmux kill-server` then retry.',
  },
];

const LSP_PATTERNS: ErrorPattern[] = [
  {
    pattern: 'command not found',
    message:
      'Language server not installed. Install the required language server on the remote host.',
  },
  {
    pattern: 'no such file or directory',
    message:
      'Language server binary not found. Install the required language server on the remote host.',
  },
  {
    pattern: 'econnrefused',
    message:
      'Could not connect to language server. Verify the server is running on the remote host.',
  },
  {
    pattern: 'connection reset',
    message: 'Language server connection was reset. The server process may have crashed.',
  },
];

const FILE_PATTERNS: ErrorPattern[] = [
  {
    pattern: 'enoent',
    message: 'File not found. The file may have been moved or deleted.',
  },
  {
    pattern: 'eacces',
    message: 'Permission denied. Check file permissions on the remote host.',
  },
  {
    pattern: 'eisdir',
    message: 'Path is a directory, not a file.',
  },
  {
    pattern: 'enospc',
    message: 'No disk space left on the remote host.',
  },
  {
    pattern: 'conflict',
    message:
      'File was modified on disk since last read. Reload the file or overwrite with your changes.',
  },
  {
    pattern: 'too large',
    message: 'File exceeds the 10 MB size limit.',
  },
];

/** Worktree port allocation range from CLAUDE.md */
const WORKTREE_PORT_MIN = 3190;
const WORKTREE_PORT_MAX = 4089;

/** Desktop tunnel port allocation range from PRD */
const DESKTOP_PORT_MIN = 4200;
const DESKTOP_PORT_MAX = 5099;

const PORT_PATTERNS: ErrorPattern[] = [
  {
    pattern: 'address already in use',
    message: 'Port is already in use. Close the other process or pick a different port.',
  },
  {
    pattern: 'eaddrinuse',
    message: 'Port is already in use. Close the other process or pick a different port.',
  },
  {
    pattern: 'bind: address already in use',
    message: 'Port is already in use. Close the other process or pick a different port.',
  },
];

const CATEGORY_PATTERNS: Record<ErrorCategory, ErrorPattern[]> = {
  ssh: SSH_PATTERNS,
  tmux: TMUX_PATTERNS,
  lsp: LSP_PATTERNS,
  file: FILE_PATTERNS,
  port: PORT_PATTERNS,
};

const CATEGORY_DEFAULTS: Record<ErrorCategory, string> = {
  ssh: 'SSH error',
  tmux: 'tmux error',
  lsp: 'Language server error',
  file: 'File operation error',
  port: 'Port allocation error',
};

/**
 * Classify a desktop error into a user-friendly message with fix hints.
 *
 * @param error - The raw error (string or Error object)
 * @param category - The error category for pattern matching
 * @returns A human-readable error message with fix hints
 */
export function classifyDesktopError(error: string | Error, category: ErrorCategory): string {
  const errorStr =
    error instanceof Error
      ? `${error.message} ${(error as Error & { stderr?: string }).stderr ?? ''}`
      : error;
  const errorLower = errorStr.toLowerCase();

  const patterns = CATEGORY_PATTERNS[category];
  for (const { pattern, message } of patterns) {
    if (errorLower.includes(pattern)) {
      return message;
    }
  }

  // Port-specific: check for worktree range collision
  if (category === 'port') {
    const portCollision = detectPortCollision(errorLower);
    if (portCollision) {
      return portCollision;
    }
  }

  const rawMessage = error instanceof Error ? error.message : error;
  return `${CATEGORY_DEFAULTS[category]}: ${rawMessage}`;
}

/**
 * Check if a tmux version string indicates version < 3.0.
 * Returns a warning message if version is too old, null otherwise.
 */
export function checkTmuxVersion(versionStr: string): string | null {
  // tmux reports version as "tmux 3.3a" or "3.3a" or "2.9"
  const match = /(\d+)\.(\d+)/.exec(versionStr);
  if (!match) {
    return 'Could not parse tmux version. Ensure tmux >= 3.0 is installed.';
  }
  const major = parseInt(match[1], 10);
  if (major < 3) {
    return `tmux ${match[0]} is too old. Archon Desktop requires tmux >= 3.0 for the -A flag. Upgrade with: \`sudo apt install tmux\``;
  }
  return null;
}

/**
 * Validate a tmux session name against the allowed pattern.
 * Returns an error message if invalid, null if valid.
 */
export function validateSessionName(name: string): string | null {
  if (!/^archon-desktop:[a-z0-9:-]+$/.test(name)) {
    return 'Invalid tmux session name. Session names must match `archon-desktop:[a-z0-9:-]+`.';
  }
  return null;
}

/**
 * Detect if a port number falls within a known allocation range,
 * returning a user-friendly collision message.
 */
export function detectPortCollision(errorOrPort: string | number): string | null {
  let port: number | null = null;

  if (typeof errorOrPort === 'number') {
    port = errorOrPort;
  } else {
    // Try to extract a port number from the error string
    const portMatch = /port\s*[:=]?\s*(\d+)/i.exec(errorOrPort);
    if (portMatch) {
      port = parseInt(portMatch[1], 10);
    }
  }

  if (port === null) {
    return null;
  }

  if (port >= WORKTREE_PORT_MIN && port <= WORKTREE_PORT_MAX) {
    return `Port ${port} is in use by an Archon worktree (range ${WORKTREE_PORT_MIN}-${WORKTREE_PORT_MAX}). Close the other Archon instance or use a different port.`;
  }

  if (port >= DESKTOP_PORT_MIN && port <= DESKTOP_PORT_MAX) {
    return `Port ${port} is in use by another Archon Desktop tunnel (range ${DESKTOP_PORT_MIN}-${DESKTOP_PORT_MAX}). Close the other desktop instance.`;
  }

  return null;
}
