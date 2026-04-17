import { useState, useEffect, useCallback, useRef } from 'react';
import type { GridPane } from './GridEngine';
import { findFreeSlot } from './GridEngine';

// ── Types ──────────────────────────────────────────────────────

export interface TmuxSession {
  name: string;
  createdAt: string;
  cwd: string;
  status: string;
}

export interface HostSessionsPanelProps {
  open: boolean;
  onClose: () => void;
  serverUrl: string;
  hosts: string[];
  existingPanes: GridPane[];
  onAttach: (pane: GridPane) => void;
  onToast: (message: string) => void;
}

// ── Pure helpers (exported for testing) ────────────────────────

/** Format age from ISO date string to human-readable. */
export function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (isNaN(created)) return 'unknown';
  const diffMs = Date.now() - created;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Build a GridPane from a tmux session for attaching to the grid. */
export function buildAttachPane(
  session: TmuxSession,
  host: string,
  existingPanes: GridPane[]
): GridPane | null {
  const slot = findFreeSlot(existingPanes, 1, 1);
  if (!slot) return null;

  return {
    id: crypto.randomUUID(),
    name: session.name.replace(/^archon-desktop:/, ''),
    host,
    cwd: session.cwd,
    sessionName: session.name,
    x: slot.x,
    y: slot.y,
    w: 1,
    h: 1,
  };
}

/** Build a GridPane for attaching at a specific grid slot. */
export function buildAttachPaneAtSlot(
  session: TmuxSession,
  host: string,
  x: number,
  y: number
): GridPane {
  return {
    id: crypto.randomUUID(),
    name: session.name.replace(/^archon-desktop:/, ''),
    host,
    cwd: session.cwd,
    sessionName: session.name,
    x,
    y,
    w: 1,
    h: 1,
  };
}

// ── Fetch helpers ─────────────────────────────────────────────

export async function fetchSessions(serverUrl: string, host: string): Promise<TmuxSession[]> {
  const res = await fetch(`${serverUrl}/api/desktop/tmux/list?host=${encodeURIComponent(host)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions: TmuxSession[] };
  return data.sessions;
}

export async function killSession(
  serverUrl: string,
  host: string,
  sessionName: string
): Promise<boolean> {
  const res = await fetch(
    `${serverUrl}/api/desktop/tmux/kill?host=${encodeURIComponent(host)}&sessionName=${encodeURIComponent(sessionName)}`,
    { method: 'POST' }
  );
  return res.ok;
}

export async function renameSession(
  serverUrl: string,
  host: string,
  from: string,
  to: string
): Promise<boolean> {
  const res = await fetch(
    `${serverUrl}/api/desktop/tmux/rename?host=${encodeURIComponent(host)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { method: 'POST' }
  );
  return res.ok;
}

// ── Session Row ───────────────────────────────────────────────

interface SessionRowProps {
  session: TmuxSession;
  host: string;
  onAttach: (session: TmuxSession, host: string) => void;
  onKill: (session: TmuxSession, host: string) => void;
  onRename: (session: TmuxSession, host: string, newName: string) => void;
  onDragStart: (e: React.DragEvent, session: TmuxSession, host: string) => void;
}

function SessionRow({
  session,
  host,
  onAttach,
  onKill,
  onRename,
  onDragStart,
}: SessionRowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [confirmKill, setConfirmKill] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const startRename = useCallback((): void => {
    setDraft(session.name);
    setRenaming(true);
  }, [session.name]);

  const commitRename = useCallback((): void => {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session, host, trimmed);
    }
  }, [draft, session, host, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setRenaming(false);
      }
    },
    [commitRename]
  );

  const handleDrag = useCallback(
    (e: React.DragEvent): void => {
      onDragStart(e, session, host);
    },
    [onDragStart, session, host]
  );

  return (
    <div className="session-row" draggable onDragStart={handleDrag}>
      <div className="session-row-main">
        <span className="session-host">{host}</span>
        <div className="session-name-cell">
          {renaming ? (
            <input
              ref={inputRef}
              className="session-rename-input"
              value={draft}
              onChange={e => {
                setDraft(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onBlur={commitRename}
            />
          ) : (
            <span className="session-name" title={session.name}>
              {session.name}
            </span>
          )}
        </div>
        <span className="session-cwd" title={session.cwd}>
          {session.cwd}
        </span>
        <span className="session-age">{formatAge(session.createdAt)}</span>
        <span className={`session-status ${session.status}`}>{session.status}</span>
      </div>
      <div className="session-actions">
        <button
          className="session-action-btn"
          onClick={(): void => {
            onAttach(session, host);
          }}
          title="Attach to grid"
        >
          Attach
        </button>
        <button className="session-action-btn" onClick={startRename} title="Rename session">
          Rename
        </button>
        {confirmKill ? (
          <>
            <button
              className="session-action-btn destructive"
              onClick={(): void => {
                setConfirmKill(false);
                onKill(session, host);
              }}
            >
              Confirm
            </button>
            <button
              className="session-action-btn"
              onClick={(): void => {
                setConfirmKill(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="session-action-btn destructive"
            onClick={(): void => {
              setConfirmKill(true);
            }}
            title="Kill session"
          >
            Kill
          </button>
        )}
      </div>
    </div>
  );
}

// ── Host Sessions Panel ───────────────────────────────────────

export function HostSessionsPanel({
  open,
  onClose,
  serverUrl,
  hosts,
  existingPanes,
  onAttach,
  onToast,
}: HostSessionsPanelProps): React.JSX.Element {
  const [sessions, setSessions] = useState<Map<string, TmuxSession[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch sessions from all hosts
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const results = new Map<string, TmuxSession[]>();
    await Promise.all(
      hosts.map(async host => {
        const hostSessions = await fetchSessions(serverUrl, host);
        results.set(host, hostSessions);
      })
    );
    setSessions(results);
    setLoading(false);
  }, [serverUrl, hosts]);

  // Auto-refresh every 15 seconds while open
  useEffect(() => {
    if (!open) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    void refresh();
    intervalRef.current = setInterval(() => {
      void refresh();
    }, 15000);
    return (): void => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [open, refresh]);

  const handleAttach = useCallback(
    (session: TmuxSession, host: string): void => {
      const pane = buildAttachPane(session, host, existingPanes);
      if (!pane) {
        onToast('Grid full — close a pane to open another');
        return;
      }
      onAttach(pane);
    },
    [existingPanes, onAttach, onToast]
  );

  const handleKill = useCallback(
    async (session: TmuxSession, host: string): Promise<void> => {
      const ok = await killSession(serverUrl, host, session.name);
      if (ok) {
        void refresh();
      } else {
        onToast(`Failed to kill session: ${session.name}`);
      }
    },
    [serverUrl, refresh, onToast]
  );

  const handleRename = useCallback(
    async (session: TmuxSession, host: string, newName: string): Promise<void> => {
      const ok = await renameSession(serverUrl, host, session.name, newName);
      if (ok) {
        void refresh();
      } else {
        onToast(`Failed to rename session: ${session.name}`);
      }
    },
    [serverUrl, refresh, onToast]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, session: TmuxSession, host: string): void => {
      e.dataTransfer.setData('application/x-archon-session', JSON.stringify({ session, host }));
      e.dataTransfer.effectAllowed = 'move';
    },
    []
  );

  // Count total sessions
  let totalSessions = 0;
  sessions.forEach(list => {
    totalSessions += list.length;
  });

  return (
    <div className={`host-sessions-drawer${open ? '' : ' collapsed'}`}>
      {open && (
        <>
          <div className="drawer-header">
            <span>Host Sessions {totalSessions > 0 ? `(${totalSessions})` : ''}</span>
            <div className="drawer-header-actions">
              <button
                className="drawer-refresh-btn"
                onClick={(): void => {
                  void refresh();
                }}
                title="Refresh"
                disabled={loading}
              >
                {loading ? '...' : '\u21BB'}
              </button>
              <button className="drawer-toggle" onClick={onClose} title="Close">
                &times;
              </button>
            </div>
          </div>
          <div className="sessions-list">
            {totalSessions === 0 && !loading && (
              <div className="sessions-empty">No tmux sessions found</div>
            )}
            {loading && totalSessions === 0 && <div className="sessions-empty">Loading...</div>}
            {hosts.map(host => {
              const hostSessions = sessions.get(host) ?? [];
              if (hostSessions.length === 0) return null;
              return (
                <div key={host} className="sessions-host-group">
                  <div className="sessions-host-label">{host}</div>
                  {hostSessions.map(session => (
                    <SessionRow
                      key={`${host}:${session.name}`}
                      session={session}
                      host={host}
                      onAttach={handleAttach}
                      onKill={(s, h): void => {
                        void handleKill(s, h);
                      }}
                      onRename={(s, h, n): void => {
                        void handleRename(s, h, n);
                      }}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
