import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as desktopModule from './desktop';
import {
  setupDesktopRoutes,
  runPreflightChecks,
  isPathWithinRoot,
  containsTraversal,
  validateSessionName,
  buildTmuxNewSessionArgs,
  buildTmuxAttachCommand,
  buildTmuxResizeArgs,
} from './desktop';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let getRemoteAddressSpy: ReturnType<typeof spyOn>;

function makeApp(): InstanceType<typeof OpenAPIHono> {
  const app = new OpenAPIHono();
  setupDesktopRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: isLoopback (pure function)
// ---------------------------------------------------------------------------

describe('isLoopback', () => {
  test('returns true for 127.0.0.1', () => {
    expect(desktopModule.isLoopback('127.0.0.1')).toBe(true);
  });

  test('returns true for ::1', () => {
    expect(desktopModule.isLoopback('::1')).toBe(true);
  });

  test('returns true for ::ffff:127.0.0.1', () => {
    expect(desktopModule.isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  test('returns false for 192.168.1.1', () => {
    expect(desktopModule.isLoopback('192.168.1.1')).toBe(false);
  });

  test('returns false for unknown', () => {
    expect(desktopModule.isLoopback('unknown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Loopback guard middleware
// ---------------------------------------------------------------------------

describe('loopback guard', () => {
  beforeEach(() => {
    getRemoteAddressSpy = spyOn(desktopModule, 'getRemoteAddress');
  });

  afterEach(() => {
    getRemoteAddressSpy.mockRestore();
  });

  test('rejects non-loopback request with 403', async () => {
    getRemoteAddressSpy.mockReturnValue('192.168.1.100');

    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('loopback-only');
  });

  test('allows loopback 127.0.0.1 request', async () => {
    getRemoteAddressSpy.mockReturnValue('127.0.0.1');

    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(200);
  });

  test('allows loopback ::1 request', async () => {
    getRemoteAddressSpy.mockReturnValue('::1');

    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(200);
  });

  test('allows loopback ::ffff:127.0.0.1 request', async () => {
    getRemoteAddressSpy.mockReturnValue('::ffff:127.0.0.1');

    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(200);
  });

  test('rejects unknown remote address', async () => {
    getRemoteAddressSpy.mockReturnValue('unknown');

    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/desktop/health
// ---------------------------------------------------------------------------

describe('GET /api/desktop/health', () => {
  beforeEach(() => {
    getRemoteAddressSpy = spyOn(desktopModule, 'getRemoteAddress');
    getRemoteAddressSpy.mockReturnValue('127.0.0.1');
  });

  afterEach(() => {
    getRemoteAddressSpy.mockRestore();
  });

  test('returns 200 with ok and version', async () => {
    const app = makeApp();
    const response = await app.request('/api/desktop/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Placeholder 501 routes
// ---------------------------------------------------------------------------

describe('placeholder 501 routes', () => {
  beforeEach(() => {
    getRemoteAddressSpy = spyOn(desktopModule, 'getRemoteAddress');
    getRemoteAddressSpy.mockReturnValue('127.0.0.1');
  });

  afterEach(() => {
    getRemoteAddressSpy.mockRestore();
  });

  const placeholderRoutes: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/desktop/fs/file?host=test&path=/test' },
    { method: 'GET', path: '/api/desktop/tmux/list?host=test' },
    { method: 'GET', path: '/api/desktop/lsp' },
  ];

  for (const { method, path } of placeholderRoutes) {
    test(`${method} ${path.split('?')[0]} returns 501`, async () => {
      const app = makeApp();
      const response = await app.request(path, { method });
      expect(response.status).toBe(501);

      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Not implemented');
    });
  }

  test('PUT /api/desktop/fs/file returns 501', async () => {
    const app = makeApp();
    const response = await app.request('/api/desktop/fs/file?host=test&path=/test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(response.status).toBe(501);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Not implemented');
  });

  test('POST /api/desktop/tmux/kill returns 501', async () => {
    const app = makeApp();
    const response = await app.request('/api/desktop/tmux/kill?host=test&sessionName=test', {
      method: 'POST',
    });
    expect(response.status).toBe(501);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Not implemented');
  });
});

// ---------------------------------------------------------------------------
// Tests: Path traversal helpers (pure functions)
// ---------------------------------------------------------------------------

describe('isPathWithinRoot', () => {
  test('accepts path equal to root', () => {
    expect(isPathWithinRoot('/home/user/project', '/home/user/project')).toBe(true);
  });

  test('accepts path inside root', () => {
    expect(isPathWithinRoot('/home/user/project/src', '/home/user/project')).toBe(true);
  });

  test('rejects path outside root via ..', () => {
    expect(isPathWithinRoot('/home/user/project/../other', '/home/user/project')).toBe(false);
  });

  test('rejects completely unrelated path', () => {
    expect(isPathWithinRoot('/etc/passwd', '/home/user/project')).toBe(false);
  });

  test('rejects path that is a prefix but not a subdirectory', () => {
    expect(isPathWithinRoot('/home/user/project-other', '/home/user/project')).toBe(false);
  });
});

describe('containsTraversal', () => {
  test('rejects paths with ..', () => {
    expect(containsTraversal('/home/user/../etc')).toBe(true);
    expect(containsTraversal('/home/user/project/../../etc')).toBe(true);
  });

  test('accepts clean absolute paths', () => {
    expect(containsTraversal('/home/user/project')).toBe(false);
    expect(containsTraversal('/home/user/project/src')).toBe(false);
    expect(containsTraversal('/')).toBe(false);
  });

  test('accepts paths with dots in names', () => {
    expect(containsTraversal('/home/user/.config')).toBe(false);
    expect(containsTraversal('/home/user/file.txt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/desktop/fs/tree
// ---------------------------------------------------------------------------

describe('GET /api/desktop/fs/tree', () => {
  let listDirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getRemoteAddressSpy = spyOn(desktopModule, 'getRemoteAddress');
    getRemoteAddressSpy.mockReturnValue('127.0.0.1');
    listDirSpy = spyOn(desktopModule, 'listDirectory');
  });

  afterEach(() => {
    getRemoteAddressSpy.mockRestore();
    listDirSpy.mockRestore();
  });

  test('returns 200 with entries for a valid directory', async () => {
    listDirSpy.mockResolvedValue([
      { name: 'src', kind: 'dir', mtime: '2026-01-01T00:00:00.000Z' },
      { name: 'package.json', kind: 'file', size: 1234, mtime: '2026-01-01T00:00:00.000Z' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/desktop/fs/tree?host=test&root=/home/user/project');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      entries: Array<{ name: string; kind: string; size?: number; mtime: string }>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].name).toBe('src');
    expect(body.entries[0].kind).toBe('dir');
    expect(body.entries[1].name).toBe('package.json');
    expect(body.entries[1].kind).toBe('file');
    expect(body.entries[1].size).toBe(1234);
  });

  test('returns 404 when path does not exist', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    listDirSpy.mockRejectedValue(err);

    const app = makeApp();
    const response = await app.request(
      '/api/desktop/fs/tree?host=test&root=/home/user/nonexistent'
    );
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 403 when permission denied', async () => {
    const err = new Error('EACCES') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    listDirSpy.mockRejectedValue(err);

    const app = makeApp();
    const response = await app.request('/api/desktop/fs/tree?host=test&root=/home/user/restricted');
    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Permission denied');
  });

  test('rejects path traversal with .. in root', async () => {
    const app = makeApp();
    const response = await app.request(
      '/api/desktop/fs/tree?host=test&root=/home/user/project/../../etc'
    );
    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('traversal');
  });

  test('returns empty entries for an empty directory', async () => {
    listDirSpy.mockResolvedValue([]);

    const app = makeApp();
    const response = await app.request('/api/desktop/fs/tree?host=test&root=/home/user/empty');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/desktop/preflight
// ---------------------------------------------------------------------------

describe('GET /api/desktop/preflight', () => {
  let checkCommandSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getRemoteAddressSpy = spyOn(desktopModule, 'getRemoteAddress');
    getRemoteAddressSpy.mockReturnValue('127.0.0.1');
    checkCommandSpy = spyOn(desktopModule, 'checkCommand');
  });

  afterEach(() => {
    getRemoteAddressSpy.mockRestore();
    checkCommandSpy.mockRestore();
  });

  test('returns 200 with checks array', async () => {
    checkCommandSpy.mockResolvedValue({ stdout: 'tmux 3.4' });

    const app = makeApp();
    const response = await app.request('/api/desktop/preflight');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { checks: Array<{ name: string; present: boolean }> };
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBe(4);

    const names = body.checks.map(c => c.name);
    expect(names).toContain('tmux');
    expect(names).toContain('aichat');
    expect(names).toContain('typescript-language-server');
    expect(names).toContain('archon');
  });

  test('marks missing dependencies as present: false', async () => {
    checkCommandSpy.mockResolvedValue(null);

    const app = makeApp();
    const response = await app.request('/api/desktop/preflight');
    const body = (await response.json()) as {
      checks: Array<{ name: string; present: boolean; installCommand?: string }>;
    };

    const tmux = body.checks.find(c => c.name === 'tmux');
    expect(tmux?.present).toBe(false);
    expect(tmux?.installCommand).toBe('sudo apt install tmux');

    const aichat = body.checks.find(c => c.name === 'aichat');
    expect(aichat?.present).toBe(false);
    expect(aichat?.installCommand).toBe('cargo install aichat');

    const tsls = body.checks.find(c => c.name === 'typescript-language-server');
    expect(tsls?.present).toBe(false);
    expect(tsls?.installCommand).toBe('npm i -g typescript-language-server typescript');
  });

  test('includes version when dependency is present', async () => {
    checkCommandSpy.mockImplementation(async (cmd: string) => {
      if (cmd === 'tmux') return { stdout: 'tmux 3.4' };
      if (cmd === 'aichat') return { stdout: 'aichat 0.24.0' };
      if (cmd === 'typescript-language-server') return { stdout: '4.3.3' };
      return null;
    });

    const app = makeApp();
    const response = await app.request('/api/desktop/preflight');
    const body = (await response.json()) as {
      checks: Array<{ name: string; present: boolean; version?: string }>;
    };

    const tmux = body.checks.find(c => c.name === 'tmux');
    expect(tmux?.present).toBe(true);
    expect(tmux?.version).toBe('3.4');

    const aichat = body.checks.find(c => c.name === 'aichat');
    expect(aichat?.present).toBe(true);
    expect(aichat?.version).toBe('0.24.0');

    const tsls = body.checks.find(c => c.name === 'typescript-language-server');
    expect(tsls?.present).toBe(true);
    expect(tsls?.version).toBe('4.3.3');
  });

  test('warns when tmux version is below 3.0', async () => {
    checkCommandSpy.mockImplementation(async (cmd: string) => {
      if (cmd === 'tmux') return { stdout: 'tmux 2.9a' };
      return null;
    });

    const app = makeApp();
    const response = await app.request('/api/desktop/preflight');
    const body = (await response.json()) as {
      checks: Array<{ name: string; warning?: string }>;
    };

    const tmux = body.checks.find(c => c.name === 'tmux');
    expect(tmux?.warning).toContain('below 3.0');
  });

  test('no warning when tmux version is 3.0+', async () => {
    checkCommandSpy.mockImplementation(async (cmd: string) => {
      if (cmd === 'tmux') return { stdout: 'tmux 3.0' };
      return null;
    });

    const app = makeApp();
    const response = await app.request('/api/desktop/preflight');
    const body = (await response.json()) as {
      checks: Array<{ name: string; warning?: string }>;
    };

    const tmux = body.checks.find(c => c.name === 'tmux');
    expect(tmux?.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: runPreflightChecks (unit)
// ---------------------------------------------------------------------------

describe('runPreflightChecks', () => {
  let checkCommandSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    checkCommandSpy = spyOn(desktopModule, 'checkCommand');
  });

  afterEach(() => {
    checkCommandSpy.mockRestore();
  });

  test('returns correct shape with all deps present', async () => {
    checkCommandSpy.mockImplementation(async (cmd: string) => {
      if (cmd === 'tmux') return { stdout: 'tmux 3.4' };
      if (cmd === 'aichat') return { stdout: 'aichat 0.24.0' };
      if (cmd === 'typescript-language-server') return { stdout: '4.3.3' };
      return null;
    });

    const checks = await runPreflightChecks();
    expect(checks).toHaveLength(4);
    expect(checks.every(c => c.present)).toBe(true);
  });

  test('returns correct shape with all deps missing', async () => {
    checkCommandSpy.mockResolvedValue(null);

    const checks = await runPreflightChecks();
    // tmux, aichat, tsls are missing; archon uses appVersion which is set at module load
    const missing = checks.filter(c => !c.present);
    expect(missing.length).toBeGreaterThanOrEqual(3);

    for (const check of missing) {
      if (check.name !== 'archon') {
        expect(check.installCommand).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: PTY WebSocket helpers — session name validation
// ---------------------------------------------------------------------------

describe('validateSessionName', () => {
  test('accepts valid session names', () => {
    expect(validateSessionName('archon-desktop:my-session')).toBe(true);
    expect(validateSessionName('archon-desktop:adhoc:abc123')).toBe(true);
    expect(validateSessionName('archon-desktop:profile-one:pane-2')).toBe(true);
    expect(validateSessionName('archon-desktop:a')).toBe(true);
    expect(validateSessionName('archon-desktop:123')).toBe(true);
  });

  test('rejects names without archon-desktop: prefix', () => {
    expect(validateSessionName('my-session')).toBe(false);
    expect(validateSessionName('other:session')).toBe(false);
    expect(validateSessionName('')).toBe(false);
  });

  test('rejects names with uppercase letters', () => {
    expect(validateSessionName('archon-desktop:MySession')).toBe(false);
  });

  test('rejects names with spaces or special characters', () => {
    expect(validateSessionName('archon-desktop:my session')).toBe(false);
    expect(validateSessionName('archon-desktop:my;session')).toBe(false);
    expect(validateSessionName('archon-desktop:$(cmd)')).toBe(false);
    expect(validateSessionName('archon-desktop:a&b')).toBe(false);
    expect(validateSessionName('archon-desktop:a|b')).toBe(false);
  });

  test('rejects names with only prefix (no content after colon)', () => {
    expect(validateSessionName('archon-desktop:')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: PTY WebSocket helpers — tmux argument construction
// ---------------------------------------------------------------------------

describe('buildTmuxNewSessionArgs', () => {
  test('builds basic new-session args', () => {
    const args = buildTmuxNewSessionArgs('archon-desktop:test');
    expect(args).toEqual(['new-session', '-A', '-d', '-s', 'archon-desktop:test']);
  });

  test('includes -c cwd when provided', () => {
    const args = buildTmuxNewSessionArgs('archon-desktop:test', '/home/user/project');
    expect(args).toEqual([
      'new-session',
      '-A',
      '-d',
      '-s',
      'archon-desktop:test',
      '-c',
      '/home/user/project',
    ]);
  });

  test('includes command when provided', () => {
    const args = buildTmuxNewSessionArgs('archon-desktop:test', '/home/user', 'claude --yolo');
    expect(args).toEqual([
      'new-session',
      '-A',
      '-d',
      '-s',
      'archon-desktop:test',
      '-c',
      '/home/user',
      'claude --yolo',
    ]);
  });

  test('includes command without cwd', () => {
    const args = buildTmuxNewSessionArgs('archon-desktop:test', undefined, 'bash');
    expect(args).toEqual(['new-session', '-A', '-d', '-s', 'archon-desktop:test', 'bash']);
  });
});

describe('buildTmuxAttachCommand', () => {
  test('builds attach command string', () => {
    const cmd = buildTmuxAttachCommand('archon-desktop:my-session');
    expect(cmd).toBe('tmux attach-session -t archon-desktop:my-session');
  });
});

describe('buildTmuxResizeArgs', () => {
  test('builds resize-window args', () => {
    const args = buildTmuxResizeArgs('archon-desktop:test', 120, 40);
    expect(args).toEqual(['resize-window', '-t', 'archon-desktop:test', '-x', '120', '-y', '40']);
  });

  test('handles small dimensions', () => {
    const args = buildTmuxResizeArgs('archon-desktop:test', 1, 1);
    expect(args).toEqual(['resize-window', '-t', 'archon-desktop:test', '-x', '1', '-y', '1']);
  });
});

// ---------------------------------------------------------------------------
// Tests: PTY WebSocket — spawnProcess verification
// ---------------------------------------------------------------------------

describe('PTY WS spawnProcess integration', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(desktopModule, 'spawnProcess');
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  test('spawnProcess is called with correct tmux new-session args', () => {
    // Mock spawnProcess to return a fake ChildProcess
    const fakeProc = {
      on: () => fakeProc,
      stdout: null,
      stderr: null,
      stdin: null,
      kill: () => true,
    };
    spawnSpy.mockReturnValue(fakeProc);

    desktopModule.spawnProcess(
      'tmux',
      buildTmuxNewSessionArgs('archon-desktop:test', '/home/user', 'claude'),
      { stdio: 'ignore' }
    );

    expect(spawnSpy).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-A', '-d', '-s', 'archon-desktop:test', '-c', '/home/user', 'claude'],
      { stdio: 'ignore' }
    );
  });

  test('spawnProcess is called with correct script attach args', () => {
    const fakeProc = {
      on: () => fakeProc,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      stdin: { write: () => true },
      kill: () => true,
    };
    spawnSpy.mockReturnValue(fakeProc);

    desktopModule.spawnProcess(
      'script',
      ['-qfc', buildTmuxAttachCommand('archon-desktop:test'), '/dev/null'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    expect(spawnSpy).toHaveBeenCalledWith(
      'script',
      ['-qfc', 'tmux attach-session -t archon-desktop:test', '/dev/null'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  test('spawnProcess is called with correct resize args', () => {
    const fakeProc = { on: () => fakeProc, kill: () => true };
    spawnSpy.mockReturnValue(fakeProc);

    desktopModule.spawnProcess('tmux', buildTmuxResizeArgs('archon-desktop:test', 80, 24), {
      stdio: 'ignore',
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'tmux',
      ['resize-window', '-t', 'archon-desktop:test', '-x', '80', '-y', '24'],
      { stdio: 'ignore' }
    );
  });
});
