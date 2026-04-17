import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as desktopModule from './desktop';
import { setupDesktopRoutes } from './desktop';

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
