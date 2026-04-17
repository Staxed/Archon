import { useState, useCallback } from 'react';
import type { AgentPreset } from './AgentPresets';
import { listPresets, savePreset, deletePreset, duplicatePreset } from './AgentPresets';

// ── Pure helpers (exported for testing) ──────────────────────────

/** Create a blank custom preset with a unique ID. */
export function createBlankPreset(): AgentPreset {
  return {
    id: crypto.randomUUID(),
    label: 'Custom Agent',
    command: '',
    args: [],
  };
}

/** Format args array as a display string. */
export function formatArgs(args: string[]): string {
  return args.join(' ');
}

/** Parse a display string back into args array. */
export function parseArgs(input: string): string[] {
  return input.split(/\s+/).filter(s => s.length > 0);
}

/** Format env record as display string. */
export function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/** Parse a display string back into env record. */
export function parseEnv(input: string): Record<string, string> | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const env: Record<string, string> = {};
  for (const pair of trimmed.split(/\s+/)) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

// ── Preset Row Component ────────────────────────────────────────

interface PresetRowProps {
  preset: AgentPreset;
  editing: boolean;
  onEdit: () => void;
  onSave: (preset: AgentPreset) => void;
  onCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function PresetRow({
  preset,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDuplicate,
  onDelete,
}: PresetRowProps): React.JSX.Element {
  const [draft, setDraft] = useState<AgentPreset>(preset);

  const handleSave = useCallback((): void => {
    onSave(draft);
  }, [draft, onSave]);

  const handleStartEdit = useCallback((): void => {
    setDraft(preset);
    onEdit();
  }, [preset, onEdit]);

  if (editing) {
    return (
      <div className="agent-preset-row editing">
        <div className="agent-preset-fields">
          <div className="agent-preset-field">
            <label className="agent-preset-label">Label</label>
            <input
              className="agent-preset-input"
              value={draft.label}
              onChange={(e): void => {
                setDraft({ ...draft, label: e.target.value });
              }}
            />
          </div>
          <div className="agent-preset-field">
            <label className="agent-preset-label">Command</label>
            <input
              className="agent-preset-input"
              value={draft.command}
              onChange={(e): void => {
                setDraft({ ...draft, command: e.target.value });
              }}
            />
          </div>
          <div className="agent-preset-field">
            <label className="agent-preset-label">Args</label>
            <input
              className="agent-preset-input wide"
              value={formatArgs(draft.args)}
              onChange={(e): void => {
                setDraft({ ...draft, args: parseArgs(e.target.value) });
              }}
            />
          </div>
          <div className="agent-preset-field">
            <label className="agent-preset-label">Env</label>
            <input
              className="agent-preset-input wide"
              value={formatEnv(draft.env)}
              onChange={(e): void => {
                setDraft({ ...draft, env: parseEnv(e.target.value) });
              }}
              placeholder="KEY=value KEY2=value2"
            />
          </div>
          <div className="agent-preset-field">
            <label className="agent-preset-label">Prompts</label>
            <input
              className="agent-preset-input"
              value={(draft.prompts ?? []).join(', ')}
              onChange={(e): void => {
                const prompts = e.target.value
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => s.length > 0);
                setDraft({ ...draft, prompts: prompts.length > 0 ? prompts : undefined });
              }}
              placeholder="MODEL, OTHER"
            />
          </div>
        </div>
        <div className="agent-preset-edit-actions">
          <button className="session-action-btn" onClick={handleSave}>
            Save
          </button>
          <button className="session-action-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-preset-row">
      <div className="agent-preset-summary">
        <span className="agent-preset-name">{preset.label}</span>
        <span className="agent-preset-cmd">
          {preset.command}{' '}
          {formatArgs(preset.args)
            .split(' ')
            .map((arg, i) => {
              if (arg.includes('{MODEL}')) {
                return (
                  <span key={i} className="agent-preset-model-chip">
                    {arg}
                  </span>
                );
              }
              return (
                <span key={i}>
                  {i > 0 ? ' ' : ''}
                  {arg}
                </span>
              );
            })}
        </span>
        {preset.env && <span className="agent-preset-env">{formatEnv(preset.env)}</span>}
        {preset.prompts && preset.prompts.length > 0 && (
          <span className="agent-preset-prompts">Prompts: {preset.prompts.join(', ')}</span>
        )}
      </div>
      <div className="agent-preset-actions">
        <button className="session-action-btn" onClick={handleStartEdit}>
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

// ── Main AgentPresetsEditor Component ────────────────────────────

export interface AgentPresetsEditorProps {
  onClose: () => void;
}

export function AgentPresetsEditor({ onClose }: AgentPresetsEditorProps): React.JSX.Element {
  const [presets, setPresets] = useState<AgentPreset[]>(() => listPresets());
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleAddCustom = useCallback((): void => {
    const blank = createBlankPreset();
    savePreset(blank);
    setPresets(listPresets());
    setEditingId(blank.id);
  }, []);

  const handleSave = useCallback((preset: AgentPreset): void => {
    savePreset(preset);
    setPresets(listPresets());
    setEditingId(null);
  }, []);

  const handleDuplicate = useCallback((preset: AgentPreset): void => {
    const dup = duplicatePreset(preset);
    savePreset(dup);
    setPresets(listPresets());
  }, []);

  const handleDelete = useCallback((id: string): void => {
    deletePreset(id);
    setPresets(listPresets());
    setEditingId(null);
  }, []);

  const handleCancel = useCallback((): void => {
    setEditingId(null);
  }, []);

  return (
    <div className="tree-modal-overlay" onClick={onClose}>
      <div
        className="tree-modal agent-presets-modal"
        onClick={(e): void => {
          e.stopPropagation();
        }}
      >
        <div className="profile-editor-header">
          <span className="tree-modal-title">Agent Presets</span>
          <button className="drawer-toggle" onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        <div className="agent-presets-list">
          <div className="profile-editor-list-header">
            <button className="tree-modal-btn" onClick={handleAddCustom}>
              + Add Custom
            </button>
          </div>

          {presets.length === 0 ? (
            <div className="profile-editor-empty">
              No agent presets. Click + Add Custom to create one.
            </div>
          ) : (
            <div className="agent-presets-items">
              {presets.map(p => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  editing={editingId === p.id}
                  onEdit={(): void => {
                    setEditingId(p.id);
                  }}
                  onSave={handleSave}
                  onCancel={handleCancel}
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
      </div>
    </div>
  );
}
