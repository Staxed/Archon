import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as desktopModule from './desktop';
import { setupDesktopRoutes, runPreflightChecks } from './desktop';

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
    { method: 'GET', path: '/api/desktop/fs/tree?host=test&root=/' },
    { method: 'GET', path: '/api/desktop/fs/file?host=test&path=/test' },
    { method: 'GET', path: '/api/desktop/tmux/list?host=test' },
    { method: 'GET', path: '/api/desktop/pty' },
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
