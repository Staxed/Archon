import { useState, useCallback, useMemo } from 'react';
import type { LaunchProfile, ProfilePane, StartupAction } from './LaunchProfile';
import { listProfiles, saveProfile, deleteProfile, toSlug } from './LaunchProfile';

// ── Pure helpers (exported for testing) ──────────────────────────

export type EditorView = 'list' | 'detail';

export interface ProfileEditorState {
  view: EditorView;
  profiles: LaunchProfile[];
  editingProfile: LaunchProfile | null;
}

/** Create a blank new profile with a unique ID. */
export function createBlankProfile(): LaunchProfile {
  return {
    id: crypto.randomUUID(),
    name: 'New Profile',
    slug: 'new-profile',
    createdAt: new Date().toISOString(),
    panes: [],
  };
}

/** Create a blank pane with defaults at position (0,0). */
export function createBlankPane(): ProfilePane {
  return {
    id: crypto.randomUUID(),
    name: 'Pane',
    type: 'terminal',
    host: 'linux-beast',
    cwd: '/home',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  };
}

/** Duplicate a profile with a new ID and "(Copy)" suffix. */
export function duplicateProfile(profile: LaunchProfile): LaunchProfile {
  const name = `${profile.name} (Copy)`;
  return {
    ...profile,
    id: crypto.randomUUID(),
    name,
    slug: toSlug(name),
    createdAt: new Date().toISOString(),
    panes: profile.panes.map(p => ({ ...p, id: crypto.randomUUID() })),
  };
}

/** Update a single pane field inside a profile. */
export function updatePaneField<K extends keyof ProfilePane>(
  profile: LaunchProfile,
  paneId: string,
  field: K,
  value: ProfilePane[K]
): LaunchProfile {
  return {
    ...profile,
    panes: profile.panes.map(p => (p.id === paneId ? { ...p, [field]: value } : p)),
  };
}

/** Remove a pane from a profile. */
export function removePane(profile: LaunchProfile, paneId: string): LaunchProfile {
  return {
    ...profile,
    panes: profile.panes.filter(p => p.id !== paneId),
  };
}

/** Add a pane to a profile. */
export function addPane(profile: LaunchProfile, pane: ProfilePane): LaunchProfile {
  return {
    ...profile,
    panes: [...profile.panes, pane],
  };
}

// ── Grid Preview Constants ───────────────────────────────────────

const PREVIEW_COLS = 6;
const PREVIEW_ROWS = 3;

// ── Grid Preview Component ───────────────────────────────────────

interface GridPreviewProps {
  panes: ProfilePane[];
}

function GridPreview({ panes }: GridPreviewProps): React.JSX.Element {
  // Build a flat grid (6x3) of cell occupancy
  const cells: (string | null)[][] = [];
  for (let r = 0; r < PREVIEW_ROWS; r++) {
    cells.push(Array.from({ length: PREVIEW_COLS }, () => null));
  }
  for (const pane of panes) {
    for (let dy = 0; dy < pane.h; dy++) {
      for (let dx = 0; dx < pane.w; dx++) {
        const r = pane.y + dy;
        const c = pane.x + dx;
        if (r < PREVIEW_ROWS && c < PREVIEW_COLS) {
          cells[r][c] = pane.id;
        }
      }
    }
  }

  return (
    <div className="profile-grid-preview">
      {cells.map((row, r) => (
        <div key={r} className="profile-grid-preview-row">
          {row.map((occupant, c) => {
            const pane = occupant ? panes.find(p => p.id === occupant) : null;
            // Only show label in the top-left cell of a pane
            const isTopLeft = pane?.x === c && pane?.y === r;
            return (
              <div
                key={c}
                className={`profile-grid-preview-cell${occupant ? ' occupied' : ''}`}
                title={pane ? `${pane.name} (${pane.w}x${pane.h})` : `Empty (${c},${r})`}
              >
                {isTopLeft ? <span className="profile-grid-preview-label">{pane.name}</span> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Pane Row Component ───────────────────────────────────────────

interface PaneRowProps {
  pane: ProfilePane;
  onUpdate: <K extends keyof ProfilePane>(field: K, value: ProfilePane[K]) => void;
  onRemove: () => void;
}

function PaneRow({ pane, onUpdate, onRemove }: PaneRowProps): React.JSX.Element {
  const handleStartupChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>): void => {
      const val = e.target.value;
      const action: StartupAction =
        val === 'none' ? { kind: 'none' } : { kind: 'agent', presetId: val };
      onUpdate('startupAction', action);
    },
    [onUpdate]
  );

  const startupValue = pane.startupAction?.kind === 'agent' ? pane.startupAction.presetId : 'none';

  return (
    <div className="profile-pane-row">
      <div className="profile-pane-field">
        <label className="profile-pane-label">Name</label>
        <input
          className="profile-pane-input"
          value={pane.name}
          onChange={e => {
            onUpdate('name', e.target.value);
          }}
        />
      </div>
      <div className="profile-pane-field">
        <label className="profile-pane-label">Host</label>
        <select
          className="profile-pane-select"
          value={pane.host}
          onChange={e => {
            onUpdate('host', e.target.value);
          }}
        >
          <option value="linux-beast">linux-beast</option>
          <option value="local-windows">local-windows</option>
          <option value="local-macos">local-macos</option>
        </select>
      </div>
      <div className="profile-pane-field">
        <label className="profile-pane-label">CWD</label>
        <input
          className="profile-pane-input wide"
          value={pane.cwd}
          onChange={e => {
            onUpdate('cwd', e.target.value);
          }}
        />
      </div>
      <div className="profile-pane-grid-pos">
        <div className="profile-pane-field small">
          <label className="profile-pane-label">X</label>
          <input
            type="number"
            className="profile-pane-input num"
            min={0}
            max={5}
            value={pane.x}
            onChange={e => {
              onUpdate('x', Math.max(0, Math.min(5, parseInt(e.target.value, 10) || 0)));
            }}
          />
        </div>
        <div className="profile-pane-field small">
          <label className="profile-pane-label">Y</label>
          <input
            type="number"
            className="profile-pane-input num"
            min={0}
            max={2}
            value={pane.y}
            onChange={e => {
              onUpdate('y', Math.max(0, Math.min(2, parseInt(e.target.value, 10) || 0)));
            }}
          />
        </div>
        <div className="profile-pane-field small">
          <label className="profile-pane-label">W</label>
          <input
            type="number"
            className="profile-pane-input num"
            min={1}
            max={6}
            value={pane.w}
            onChange={e => {
              onUpdate('w', Math.max(1, Math.min(6, parseInt(e.target.value, 10) || 1)));
            }}
          />
        </div>
        <div className="profile-pane-field small">
          <label className="profile-pane-label">H</label>
          <input
            type="number"
            className="profile-pane-input num"
            min={1}
            max={3}
            value={pane.h}
            onChange={e => {
              onUpdate('h', Math.max(1, Math.min(3, parseInt(e.target.value, 10) || 1)));
            }}
          />
        </div>
      </div>
      <div className="profile-pane-field">
        <label className="profile-pane-label">Startup</label>
        <select className="profile-pane-select" value={startupValue} onChange={handleStartupChange}>
          <option value="none">None</option>
          <option value="claude">Claude</option>
          <option value="claude-yolo">Claude (YOLO)</option>
          <option value="codex">Codex</option>
          <option value="codex-yolo">Codex (YOLO)</option>
          <option value="gemini">Gemini</option>
          <option value="gemini-yolo">Gemini (YOLO)</option>
          <option value="openrouter-aichat">OpenRouter (aichat)</option>
          <option value="llamacpp-aichat">Llama.cpp (aichat)</option>
        </select>
      </div>
      <button className="profile-pane-remove-btn" onClick={onRemove} title="Remove pane">
        &times;
      </button>
    </div>
  );
}

// ── Profile Detail View ──────────────────────────────────────────

interface ProfileDetailProps {
  profile: LaunchProfile;
  onChange: (profile: LaunchProfile) => void;
  onSave: () => void;
  onCancel: () => void;
}

function ProfileDetail({
  profile,
  onChange,
  onSave,
  onCancel,
}: ProfileDetailProps): React.JSX.Element {
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const name = e.target.value;
      onChange({ ...profile, name, slug: toSlug(name) });
    },
    [profile, onChange]
  );

  const handleUpdatePane = useCallback(
    <K extends keyof ProfilePane>(paneId: string, field: K, value: ProfilePane[K]): void => {
      onChange(updatePaneField(profile, paneId, field, value));
    },
    [profile, onChange]
  );

  const handleRemovePane = useCallback(
    (paneId: string): void => {
      onChange(removePane(profile, paneId));
    },
    [profile, onChange]
  );

  const handleAddPane = useCallback((): void => {
    onChange(addPane(profile, createBlankPane()));
  }, [profile, onChange]);

  return (
    <div className="profile-detail">
      <div className="profile-detail-header">
        <div className="profile-detail-name-field">
          <label className="profile-pane-label">Profile Name</label>
          <input
            className="profile-detail-name-input"
            value={profile.name}
            onChange={handleNameChange}
          />
        </div>
        <div className="profile-detail-actions">
          <button className="tree-modal-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="tree-modal-btn" onClick={onSave}>
            Save
          </button>
        </div>
      </div>

      <div className="profile-detail-section">
        <div className="profile-detail-section-title">Grid Preview</div>
        <GridPreview panes={profile.panes} />
      </div>

      <div className="profile-detail-section">
        <div className="profile-detail-section-header">
          <span className="profile-detail-section-title">Panes ({profile.panes.length})</span>
          <button className="profile-add-pane-btn" onClick={handleAddPane}>
            + Add Pane
          </button>
        </div>
        {profile.panes.length === 0 ? (
          <div className="profile-panes-empty">No panes defined. Click + Add Pane to start.</div>
        ) : (
          <div className="profile-panes-list">
            {profile.panes.map(pane => (
              <PaneRow
                key={pane.id}
                pane={pane}
                onUpdate={(field, value): void => {
                  handleUpdatePane(pane.id, field, value);
                }}
                onRemove={(): void => {
                  handleRemovePane(pane.id);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Profile List View ────────────────────────────────────────────

interface ProfileListItemProps {
  profile: LaunchProfile;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function ProfileListItem({
  profile,
  onEdit,
  onDuplicate,
  onDelete,
}: ProfileListItemProps): React.JSX.Element {
  return (
    <div className="profile-list-item">
      <div className="profile-list-item-info">
        <span className="profile-list-item-name">{profile.name}</span>
        <span className="profile-list-item-meta">
          {profile.panes.length} pane{profile.panes.length !== 1 ? 's' : ''} &middot;{' '}
          {new Date(profile.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="profile-list-item-actions">
        <button className="session-action-btn" onClick={onEdit}>
          Edit
        </button>
        <button className="session-action-btn" onClick={onDuplicate}>
          Duplicate
        </button>
        <button className="session-action-btn destructive" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Main ProfileEditor Component ─────────────────────────────────

export interface ProfileEditorProps {
  onClose: () => void;
}

export function ProfileEditor({ onClose }: ProfileEditorProps): React.JSX.Element {
  const [view, setView] = useState<EditorView>('list');
  const [profiles, setProfiles] = useState<LaunchProfile[]>(() => listProfiles());
  const [editingProfile, setEditingProfile] = useState<LaunchProfile | null>(null);

  const handleNew = useCallback((): void => {
    const profile = createBlankProfile();
    setEditingProfile(profile);
    setView('detail');
  }, []);

  const handleEdit = useCallback((profile: LaunchProfile): void => {
    setEditingProfile({ ...profile, panes: profile.panes.map(p => ({ ...p })) });
    setView('detail');
  }, []);

  const handleDuplicate = useCallback((profile: LaunchProfile): void => {
    const dup = duplicateProfile(profile);
    saveProfile(dup);
    setProfiles(listProfiles());
  }, []);

  const handleDelete = useCallback((id: string): void => {
    deleteProfile(id);
    setProfiles(listProfiles());
  }, []);

  const handleSave = useCallback((): void => {
    if (!editingProfile) return;
    const toSave: LaunchProfile = {
      ...editingProfile,
      slug: toSlug(editingProfile.name),
    };
    saveProfile(toSave);
    setProfiles(listProfiles());
    setEditingProfile(null);
    setView('list');
  }, [editingProfile]);

  const handleCancel = useCallback((): void => {
    setEditingProfile(null);
    setView('list');
  }, []);

  const handleProfileChange = useCallback((profile: LaunchProfile): void => {
    setEditingProfile(profile);
  }, []);

  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [profiles]
  );

  return (
    <div className="tree-modal-overlay" onClick={onClose}>
      <div
        className="tree-modal profile-editor-modal"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="profile-editor-header">
          <span className="tree-modal-title">Launch Profiles</span>
          <button className="drawer-toggle" onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        {view === 'list' ? (
          <div className="profile-editor-list">
            <div className="profile-editor-list-header">
              <button className="tree-modal-btn" onClick={handleNew}>
                + New Profile
              </button>
            </div>
            {sortedProfiles.length === 0 ? (
              <div className="profile-editor-empty">
                No profiles yet. Create one to save your terminal layout.
              </div>
            ) : (
              <div className="profile-editor-items">
                {sortedProfiles.map(p => (
                  <ProfileListItem
                    key={p.id}
                    profile={p}
                    onEdit={(): void => {
                      handleEdit(p);
                    }}
                    onDuplicate={(): void => {
                      handleDuplicate(p);
                    }}
                    onDelete={(): void => {
                      handleDelete(p.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          editingProfile && (
            <ProfileDetail
              profile={editingProfile}
              onChange={handleProfileChange}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )
        )}
      </div>
    </div>
  );
}
