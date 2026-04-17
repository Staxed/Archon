import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { saveFile, isSaveShortcut, getDirtyFileNames, hasDirtyTabs } from './SaveFlow';

// ── Mock fetch ─────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// ── saveFile tests ─────────────────────────────────────────────

describe('saveFile', () => {
  it('returns success with mtime on 200', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, mtime: '2026-04-17T12:00:00Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ) as typeof fetch;

    const result = await saveFile('http://localhost:3090', 'linux-beast', '/tmp/test.txt', 'hello');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.mtime).toBe('2026-04-17T12:00:00Z');
    }
  });

  it('sends expectedMtime when provided', async () => {
    let capturedBody = '';
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, mtime: '2026-04-17T12:00:00Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;

    await saveFile(
      'http://localhost:3090',
      'linux-beast',
      '/tmp/test.txt',
      'hello',
      '2026-04-17T11:00:00Z'
    );

    const body = JSON.parse(capturedBody) as { content: string; expectedMtime?: string };
    expect(body.content).toBe('hello');
    expect(body.expectedMtime).toBe('2026-04-17T11:00:00Z');
  });

  it('does not send expectedMtime when not provided', async () => {
    let capturedBody = '';
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, mtime: '2026-04-17T12:00:00Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;

    await saveFile('http://localhost:3090', 'linux-beast', '/tmp/test.txt', 'hello');

    const body = JSON.parse(capturedBody) as { content: string; expectedMtime?: string };
    expect(body.content).toBe('hello');
    expect(body.expectedMtime).toBeUndefined();
  });

  it('returns conflict on 409 with current content and mtime', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'File changed on disk',
            currentContent: 'updated content',
            currentMtime: '2026-04-17T12:30:00Z',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      )
    ) as typeof fetch;

    const result = await saveFile(
      'http://localhost:3090',
      'linux-beast',
      '/tmp/test.txt',
      'hello',
      '2026-04-17T11:00:00Z'
    );
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.currentContent).toBe('updated content');
      expect(result.currentMtime).toBe('2026-04-17T12:30:00Z');
    }
  });

  it('returns error on non-200/409 status', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Not Found', { status: 404 }))
    ) as typeof fetch;

    const result = await saveFile('http://localhost:3090', 'linux-beast', '/tmp/test.txt', 'hello');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('404');
    }
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as typeof fetch;

    const result = await saveFile('http://localhost:3090', 'linux-beast', '/tmp/test.txt', 'hello');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toBe('Network error');
    }
  });

  it('constructs correct URL with encoded params', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string | URL | Request) => {
      capturedUrl = url as string;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, mtime: 'x' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;

    await saveFile('http://localhost:3090', 'linux-beast', '/home/user/my file.txt', 'content');

    expect(capturedUrl).toContain('host=linux-beast');
    expect(capturedUrl).toContain('path=%2Fhome%2Fuser%2Fmy%20file.txt');
  });
});

// ── isSaveShortcut tests ───────────────────────────────────────

describe('isSaveShortcut', () => {
  it('returns true for Ctrl+S', () => {
    const event = { ctrlKey: true, metaKey: false, key: 's' } as KeyboardEvent;
    expect(isSaveShortcut(event)).toBe(true);
  });

  it('returns true for Cmd+S (macOS)', () => {
    const event = { ctrlKey: false, metaKey: true, key: 's' } as KeyboardEvent;
    expect(isSaveShortcut(event)).toBe(true);
  });

  it('returns false for just S key', () => {
    const event = { ctrlKey: false, metaKey: false, key: 's' } as KeyboardEvent;
    expect(isSaveShortcut(event)).toBe(false);
  });

  it('returns false for Ctrl+other key', () => {
    const event = { ctrlKey: true, metaKey: false, key: 'a' } as KeyboardEvent;
    expect(isSaveShortcut(event)).toBe(false);
  });
});

// ── getDirtyFileNames tests ────────────────────────────────────

describe('getDirtyFileNames', () => {
  it('returns names of dirty tabs only', () => {
    const tabs = [
      { dirty: true, name: 'file1.ts' },
      { dirty: false, name: 'file2.ts' },
      { dirty: true, name: 'file3.ts' },
    ];
    expect(getDirtyFileNames(tabs)).toEqual(['file1.ts', 'file3.ts']);
  });

  it('returns empty array when no dirty tabs', () => {
    const tabs = [
      { dirty: false, name: 'file1.ts' },
      { dirty: false, name: 'file2.ts' },
    ];
    expect(getDirtyFileNames(tabs)).toEqual([]);
  });

  it('returns empty array for empty tabs', () => {
    expect(getDirtyFileNames([])).toEqual([]);
  });
});

// ── hasDirtyTabs tests ─────────────────────────────────────────

describe('hasDirtyTabs', () => {
  it('returns true when any tab is dirty', () => {
    const tabs = [{ dirty: false }, { dirty: true }, { dirty: false }];
    expect(hasDirtyTabs(tabs)).toBe(true);
  });

  it('returns false when no tabs are dirty', () => {
    const tabs = [{ dirty: false }, { dirty: false }];
    expect(hasDirtyTabs(tabs)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasDirtyTabs([])).toBe(false);
  });
});
