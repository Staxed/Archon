import { describe, expect, test } from 'bun:test';
import {
  classifyDesktopError,
  checkTmuxVersion,
  validateSessionName,
  detectPortCollision,
} from './errors';

describe('classifyDesktopError — ssh', () => {
  test('host key verification failed', () => {
    const result = classifyDesktopError('Host key verification failed', 'ssh');
    expect(result).toContain('ssh-keygen -R');
  });

  test('permission denied (publickey)', () => {
    const result = classifyDesktopError('Permission denied (publickey)', 'ssh');
    expect(result).toContain('SSH key');
  });

  test('generic permission denied', () => {
    const result = classifyDesktopError('Permission denied', 'ssh');
    expect(result).toContain('SSH permission denied');
  });

  test('connection refused', () => {
    const result = classifyDesktopError('Connection refused', 'ssh');
    expect(result).toContain('SSH port');
  });

  test('no such host', () => {
    const result = classifyDesktopError('ssh: no such host beast.local', 'ssh');
    expect(result).toContain('hostname');
  });

  test('could not resolve hostname', () => {
    const result = classifyDesktopError('ssh: Could not resolve hostname beast', 'ssh');
    expect(result).toContain('resolved');
  });

  test('connection timed out', () => {
    const result = classifyDesktopError('ssh: connection timed out', 'ssh');
    expect(result).toContain('timed out');
  });

  test('operation timed out', () => {
    const result = classifyDesktopError('Operation timed out', 'ssh');
    expect(result).toContain('timed out');
  });

  test('network unreachable', () => {
    const result = classifyDesktopError('Network is unreachable', 'ssh');
    expect(result).toContain('internet connection');
  });

  test('unknown ssh error includes raw message', () => {
    const result = classifyDesktopError('Some weird SSH error', 'ssh');
    expect(result).toContain('SSH error');
    expect(result).toContain('Some weird SSH error');
  });

  test('Error object with stderr', () => {
    const err = new Error('ssh failed') as Error & { stderr: string };
    err.stderr = 'Permission denied (publickey)';
    const result = classifyDesktopError(err, 'ssh');
    expect(result).toContain('SSH key');
  });
});

describe('classifyDesktopError — tmux', () => {
  test('command not found', () => {
    const result = classifyDesktopError('tmux: command not found', 'tmux');
    expect(result).toContain('not installed');
    expect(result).toContain('apt install tmux');
  });

  test('no such file or directory', () => {
    const result = classifyDesktopError('/usr/bin/tmux: No such file or directory', 'tmux');
    expect(result).toContain('not found');
  });

  test('session name invalid', () => {
    const result = classifyDesktopError('session name invalid', 'tmux');
    expect(result).toContain('archon-desktop');
  });

  test('protocol version mismatch', () => {
    const result = classifyDesktopError('protocol version mismatch', 'tmux');
    expect(result).toContain('kill-server');
  });

  test('unknown tmux error includes raw message', () => {
    const result = classifyDesktopError('unexpected tmux failure', 'tmux');
    expect(result).toContain('tmux error');
    expect(result).toContain('unexpected tmux failure');
  });
});

describe('classifyDesktopError — lsp', () => {
  test('command not found', () => {
    const result = classifyDesktopError('typescript-language-server: command not found', 'lsp');
    expect(result).toContain('not installed');
  });

  test('no such file or directory', () => {
    const result = classifyDesktopError('No such file or directory: gopls', 'lsp');
    expect(result).toContain('not found');
  });

  test('connection refused', () => {
    const result = classifyDesktopError('ECONNREFUSED', 'lsp');
    expect(result).toContain('not connect');
  });

  test('connection reset', () => {
    const result = classifyDesktopError('connection reset by peer', 'lsp');
    expect(result).toContain('crashed');
  });

  test('unknown lsp error', () => {
    const result = classifyDesktopError('lsp internal error', 'lsp');
    expect(result).toContain('Language server error');
  });
});

describe('classifyDesktopError — file', () => {
  test('enoent', () => {
    const result = classifyDesktopError('ENOENT: no such file', 'file');
    expect(result).toContain('not found');
  });

  test('eacces', () => {
    const result = classifyDesktopError('EACCES: permission denied', 'file');
    expect(result).toContain('Permission denied');
  });

  test('eisdir', () => {
    const result = classifyDesktopError('EISDIR: is a directory', 'file');
    expect(result).toContain('directory');
  });

  test('enospc', () => {
    const result = classifyDesktopError('ENOSPC: no space left', 'file');
    expect(result).toContain('disk space');
  });

  test('conflict', () => {
    const result = classifyDesktopError('409 Conflict', 'file');
    expect(result).toContain('modified on disk');
  });

  test('too large', () => {
    const result = classifyDesktopError('File too large', 'file');
    expect(result).toContain('10 MB');
  });

  test('unknown file error', () => {
    const result = classifyDesktopError('Bizarre file error', 'file');
    expect(result).toContain('File operation error');
  });
});

describe('classifyDesktopError — port', () => {
  test('address already in use', () => {
    const result = classifyDesktopError('Address already in use', 'port');
    expect(result).toContain('already in use');
  });

  test('eaddrinuse', () => {
    const result = classifyDesktopError('EADDRINUSE', 'port');
    expect(result).toContain('already in use');
  });

  test('worktree port collision', () => {
    const result = classifyDesktopError('failed to bind to port: 3500', 'port');
    expect(result).toContain('Archon worktree');
    expect(result).toContain('3190-4089');
  });

  test('desktop tunnel port collision', () => {
    const result = classifyDesktopError('address in use port: 4500', 'port');
    expect(result).toContain('Archon Desktop tunnel');
    expect(result).toContain('4200-5099');
  });

  test('unknown port error', () => {
    const result = classifyDesktopError('weird port thing', 'port');
    expect(result).toContain('Port allocation error');
  });
});

describe('checkTmuxVersion', () => {
  test('returns null for 3.0+', () => {
    expect(checkTmuxVersion('tmux 3.3a')).toBeNull();
  });

  test('returns null for 3.0 exactly', () => {
    expect(checkTmuxVersion('3.0')).toBeNull();
  });

  test('returns null for 4.0', () => {
    expect(checkTmuxVersion('tmux 4.0')).toBeNull();
  });

  test('returns warning for 2.9', () => {
    const result = checkTmuxVersion('tmux 2.9');
    expect(result).toContain('too old');
    expect(result).toContain('>= 3.0');
  });

  test('returns warning for 1.8', () => {
    const result = checkTmuxVersion('1.8');
    expect(result).toContain('too old');
  });

  test('returns error for unparseable version', () => {
    const result = checkTmuxVersion('unknown');
    expect(result).toContain('Could not parse');
  });
});

describe('validateSessionName', () => {
  test('valid name', () => {
    expect(validateSessionName('archon-desktop:my-session:0')).toBeNull();
  });

  test('valid adhoc name', () => {
    expect(validateSessionName('archon-desktop:adhoc:abc-123')).toBeNull();
  });

  test('rejects missing prefix', () => {
    const result = validateSessionName('my-session');
    expect(result).toContain('archon-desktop');
  });

  test('rejects uppercase', () => {
    const result = validateSessionName('archon-desktop:MySession');
    expect(result).toContain('archon-desktop');
  });

  test('rejects empty suffix', () => {
    const result = validateSessionName('archon-desktop:');
    expect(result).toContain('archon-desktop');
  });

  test('rejects spaces', () => {
    const result = validateSessionName('archon-desktop:my session');
    expect(result).not.toBeNull();
  });
});

describe('detectPortCollision', () => {
  test('worktree range by number', () => {
    const result = detectPortCollision(3500);
    expect(result).toContain('Archon worktree');
  });

  test('desktop range by number', () => {
    const result = detectPortCollision(4500);
    expect(result).toContain('Archon Desktop tunnel');
  });

  test('outside all ranges', () => {
    expect(detectPortCollision(8080)).toBeNull();
  });

  test('worktree range boundary min', () => {
    const result = detectPortCollision(3190);
    expect(result).toContain('Archon worktree');
  });

  test('worktree range boundary max', () => {
    const result = detectPortCollision(4089);
    expect(result).toContain('Archon worktree');
  });

  test('desktop range boundary min', () => {
    const result = detectPortCollision(4200);
    expect(result).toContain('Archon Desktop tunnel');
  });

  test('desktop range boundary max', () => {
    const result = detectPortCollision(5099);
    expect(result).toContain('Archon Desktop tunnel');
  });

  test('extracts port from error string', () => {
    const result = detectPortCollision('failed port: 3500');
    expect(result).toContain('Archon worktree');
  });

  test('returns null when no port in string', () => {
    expect(detectPortCollision('some random error')).toBeNull();
  });
});
