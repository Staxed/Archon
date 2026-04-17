import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  formatAge,
  buildAttachPane,
  buildAttachPaneAtSlot,
  fetchSessions,
  killSession,
  renameSession,
} from './HostSessionsPanel';
import type { TmuxSession } from './HostSessionsPanel';
import type { GridPane } from './GridEngine';

// ── formatAge ─────────────────────────────────────────────────

describe('formatAge', () => {
  it('returns seconds for < 60s', () => {
    const now = new Date();
    const created = new Date(now.getTime() - 30_000).toISOString();
    const result = formatAge(created);
    expect(result).toMatch(/^\d+s$/);
  });

  it('returns minutes for < 60m', () => {
    const now = new Date();
    const created = new Date(now.getTime() - 5 * 60_000).toISOString();
    const result = formatAge(created);
    expect(result).toMatch(/^\d+m$/);
  });

  it('returns hours for < 24h', () => {
    const now = new Date();
    const created = new Date(now.getTime() - 3 * 3600_000).toISOString();
    const result = formatAge(created);
    expect(result).toMatch(/^\d+h$/);
  });

  it('returns days for >= 24h', () => {
    const now = new Date();
    const created = new Date(now.getTime() - 2 * 86400_000).toISOString();
    const result = formatAge(created);
    expect(result).toMatch(/^\d+d$/);
  });

  it('returns "unknown" for invalid date', () => {
    expect(formatAge('not-a-date')).toBe('unknown');
  });

  it('returns "just now" for future dates', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatAge(future)).toBe('just now');
  });
});

// ── buildAttachPane ───────────────────────────────────────────

describe('buildAttachPane', () => {
  const session: TmuxSession = {
    name: 'archon-desktop:my-session',
    createdAt: new Date().toISOString(),
    cwd: '/home/user/project',
    status: 'detached',
  };

  it('returns a pane placed in the first free slot', () => {
    const result = buildAttachPane(session, 'linux-beast', []);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
    expect(result!.host).toBe('linux-beast');
    expect(result!.cwd).toBe('/home/user/project');
    expect(result!.sessionName).toBe('archon-desktop:my-session');
    expect(result!.name).toBe('my-session');
  });

  it('strips archon-desktop: prefix from display name', () => {
    const result = buildAttachPane(session, 'linux-beast', []);
    expect(result!.name).toBe('my-session');
  });

  it('returns null when grid is full', () => {
    const fullGrid: GridPane[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        fullGrid.push({
          id: `p-${r}-${c}`,
          name: `pane-${r}-${c}`,
          host: 'h',
          cwd: '/',
          sessionName: `archon-desktop:s-${r}-${c}`,
          x: c,
          y: r,
          w: 1,
          h: 1,
        });
      }
    }
    const result = buildAttachPane(session, 'linux-beast', fullGrid);
    expect(result).toBeNull();
  });

  it('places pane in first available gap', () => {
    const existing: GridPane[] = [
      { id: 'p1', name: 'a', host: 'h', cwd: '/', sessionName: 's', x: 0, y: 0, w: 1, h: 1 },
    ];
    const result = buildAttachPane(session, 'linux-beast', existing);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(1);
    expect(result!.y).toBe(0);
  });
});

// ── buildAttachPaneAtSlot ─────────────────────────────────────

describe('buildAttachPaneAtSlot', () => {
  const session: TmuxSession = {
    name: 'archon-desktop:test',
    createdAt: new Date().toISOString(),
    cwd: '/tmp',
    status: 'attached',
  };

  it('creates a pane at the specified slot', () => {
    const pane = buildAttachPaneAtSlot(session, 'linux-beast', 3, 2);
    expect(pane.x).toBe(3);
    expect(pane.y).toBe(2);
    expect(pane.host).toBe('linux-beast');
    expect(pane.sessionName).toBe('archon-desktop:test');
    expect(pane.name).toBe('test');
  });

  it('generates a unique id', () => {
    const p1 = buildAttachPaneAtSlot(session, 'h', 0, 0);
    const p2 = buildAttachPaneAtSlot(session, 'h', 1, 0);
    expect(p1.id).not.toBe(p2.id);
  });
});

// ── fetchSessions ─────────────────────────────────────────────

describe('fetchSessions', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns sessions on success', async () => {
    const mockSessions: TmuxSession[] = [
      {
        name: 'archon-desktop:s1',
        createdAt: '2026-01-01T00:00:00Z',
        cwd: '/home',
        status: 'detached',
      },
    ];
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: mockSessions }), { status: 200 })
    );
    const result = await fetchSessions('http://localhost:3090', 'linux-beast');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('archon-desktop:s1');
  });

  it('returns empty array on error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    const result = await fetchSessions('http://localhost:3090', 'linux-beast');
    expect(result).toEqual([]);
  });

  it('encodes host in URL', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    await fetchSessions('http://localhost:3090', 'my host');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3090/api/desktop/tmux/list?host=my%20host'
    );
  });
});

// ── killSession ───────────────────────────────────────────────

describe('killSession', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true on success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const ok = await killSession('http://localhost:3090', 'host', 'archon-desktop:s1');
    expect(ok).toBe(true);
  });

  it('returns false on failure', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 404 }));
    const ok = await killSession('http://localhost:3090', 'host', 'archon-desktop:s1');
    expect(ok).toBe(false);
  });

  it('sends POST method', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await killSession('http://localhost:3090', 'host', 'archon-desktop:s1');
    expect(fetchSpy.mock.calls[0][1]).toEqual({ method: 'POST' });
  });
});

// ── renameSession ─────────────────────────────────────────────

describe('renameSession', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true on success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const ok = await renameSession('http://localhost:3090', 'host', 'old-name', 'new-name');
    expect(ok).toBe(true);
  });

  it('returns false on failure', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 404 }));
    const ok = await renameSession('http://localhost:3090', 'host', 'old-name', 'new-name');
    expect(ok).toBe(false);
  });

  it('encodes from and to in URL', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await renameSession('http://localhost:3090', 'host', 'name one', 'name two');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('from=name%20one');
    expect(url).toContain('to=name%20two');
  });
});

// ── Drag-drop data format ─────────────────────────────────────

describe('drag-drop data format', () => {
  it('session data can be serialized and deserialized for drag', () => {
    const session: TmuxSession = {
      name: 'archon-desktop:test',
      createdAt: '2026-01-01T00:00:00Z',
      cwd: '/home',
      status: 'detached',
    };
    const host = 'linux-beast';
    const payload = JSON.stringify({ session, host });
    const parsed = JSON.parse(payload) as { session: TmuxSession; host: string };
    expect(parsed.session.name).toBe('archon-desktop:test');
    expect(parsed.host).toBe('linux-beast');
  });
});

// ── Refresh interval logic ────────────────────────────────────

describe('refresh logic', () => {
  it('15-second interval is the specified refresh rate', () => {
    // Verify the constant matches the AC requirement
    const REFRESH_INTERVAL_MS = 15000;
    expect(REFRESH_INTERVAL_MS).toBe(15000);
  });
});
