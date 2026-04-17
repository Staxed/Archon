import { useState, useCallback } from 'react';
import type { AgentPreset } from './AgentPresets';
import {
  buildDropdownOptions,
  needsModelPrompt,
  loadRecentModels,
  addRecentModel,
  isYoloPreset,
} from './AgentLauncher';
import type { LauncherSelection } from './AgentLauncher';

// ── Agent Launcher Dropdown ─────────────────────────────────────

export interface AgentLauncherDropdownProps {
  onSelect: (selection: LauncherSelection) => void;
  onCancel: () => void;
}

export function AgentLauncherDropdown({
  onSelect,
  onCancel,
}: AgentLauncherDropdownProps): React.JSX.Element {
  const [selectedPreset, setSelectedPreset] = useState<AgentPreset | null>(null);
  const [showModelPrompt, setShowModelPrompt] = useState(false);
  const [modelValue, setModelValue] = useState('');
  const [showCustomModal, setShowCustomModal] = useState(false);

  const options = buildDropdownOptions();

  const handleDropdownChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>): void => {
      const id = e.target.value;
      if (id === '__none__') {
        onSelect({ kind: 'none' });
        return;
      }
      if (id === '__custom__') {
        setShowCustomModal(true);
        return;
      }
      const option = options.find(o => o.id === id);
      if (!option?.preset) return;

      if (needsModelPrompt(option.preset)) {
        setSelectedPreset(option.preset);
        setShowModelPrompt(true);
        // Pre-fill with most recent model choice
        const recent = loadRecentModels();
        if (recent.length > 0) {
          setModelValue(recent[0]);
        }
      } else {
        onSelect({ kind: 'preset', preset: option.preset });
      }
    },
    [options, onSelect]
  );

  const handleModelConfirm = useCallback((): void => {
    if (!selectedPreset) return;
    const trimmed = modelValue.trim();
    if (!trimmed) return;
    addRecentModel(trimmed);
    onSelect({ kind: 'preset', preset: selectedPreset, modelOverride: trimmed });
  }, [selectedPreset, modelValue, onSelect]);

  const handleModelKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        handleModelConfirm();
      } else if (e.key === 'Escape') {
        setShowModelPrompt(false);
        setSelectedPreset(null);
      }
    },
    [handleModelConfirm]
  );

  // ── Model prompt ──────────────────────────────────────────────
  if (showModelPrompt && selectedPreset) {
    const recentModels = loadRecentModels();
    return (
      <div className="agent-launcher-model-prompt">
        <div className="agent-launcher-model-header">
          Select model for{' '}
          <strong className={isYoloPreset(selectedPreset) ? 'yolo-label' : ''}>
            {selectedPreset.label}
          </strong>
        </div>
        <input
          className="agent-launcher-model-input"
          placeholder="e.g. anthropic/claude-3-haiku"
          value={modelValue}
          onChange={e => {
            setModelValue(e.target.value);
          }}
          onKeyDown={handleModelKeyDown}
          autoFocus
          list="recent-models-list"
        />
        <datalist id="recent-models-list">
          {recentModels.map(m => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="agent-launcher-model-actions">
          <button
            className="agent-launcher-btn primary"
            onClick={handleModelConfirm}
            disabled={!modelValue.trim()}
          >
            OK
          </button>
          <button
            className="agent-launcher-btn"
            onClick={(): void => {
              setShowModelPrompt(false);
              setSelectedPreset(null);
              onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Custom modal ──────────────────────────────────────────────
  if (showCustomModal) {
    return (
      <CustomAgentModal
        onConfirm={(selection): void => {
          onSelect(selection);
        }}
        onCancel={(): void => {
          setShowCustomModal(false);
          onCancel();
        }}
      />
    );
  }

  // ── Default dropdown ──────────────────────────────────────────
  return (
    <div className="agent-launcher-dropdown">
      <label className="agent-launcher-label">Start with…</label>
      <select className="agent-launcher-select" defaultValue="" onChange={handleDropdownChange}>
        <option value="" disabled>
          Choose agent…
        </option>
        {options.map(o => (
          <option
            key={o.id}
            value={o.id}
            className={o.preset && isYoloPreset(o.preset) ? 'yolo-option' : ''}
          >
            {o.label}
          </option>
        ))}
      </select>
      <button className="agent-launcher-btn" onClick={onCancel}>
        Skip
      </button>
    </div>
  );
}

// ── Custom Agent Modal ──────────────────────────────────────────

interface CustomAgentModalProps {
  onConfirm: (selection: LauncherSelection) => void;
  onCancel: () => void;
}

function CustomAgentModal({ onConfirm, onCancel }: CustomAgentModalProps): React.JSX.Element {
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [cwdOverride, setCwdOverride] = useState('');

  const handleConfirm = useCallback((): void => {
    const trimmedCmd = command.trim();
    if (!trimmedCmd) return;

    const parsedArgs = args
      .split(/\s+/)
      .map(a => a.trim())
      .filter(Boolean);
    const parsedEnv: Record<string, string> = {};
    if (env.trim()) {
      for (const line of env.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          parsedEnv[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
    }

    onConfirm({
      kind: 'custom',
      command: trimmedCmd,
      args: parsedArgs,
      env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      cwdOverride: cwdOverride.trim() || undefined,
    });
  }, [command, args, env, cwdOverride, onConfirm]);

  return (
    <div className="agent-launcher-custom-modal">
      <div className="agent-launcher-custom-header">Custom Agent</div>
      <div className="agent-launcher-custom-field">
        <label>Command</label>
        <input
          value={command}
          onChange={e => {
            setCommand(e.target.value);
          }}
          placeholder="e.g. claude"
          autoFocus
        />
      </div>
      <div className="agent-launcher-custom-field">
        <label>Arguments</label>
        <input
          value={args}
          onChange={e => {
            setArgs(e.target.value);
          }}
          placeholder="e.g. --dangerously-skip-permissions"
        />
      </div>
      <div className="agent-launcher-custom-field">
        <label>Environment (KEY=VALUE, one per line)</label>
        <textarea
          value={env}
          onChange={e => {
            setEnv(e.target.value);
          }}
          rows={2}
          placeholder="API_KEY=..."
        />
      </div>
      <div className="agent-launcher-custom-field">
        <label>Working directory override (optional)</label>
        <input
          value={cwdOverride}
          onChange={e => {
            setCwdOverride(e.target.value);
          }}
          placeholder="/path/to/project"
        />
      </div>
      <div className="agent-launcher-custom-actions">
        <button
          className="agent-launcher-btn primary"
          onClick={handleConfirm}
          disabled={!command.trim()}
        >
          Start
        </button>
        <button className="agent-launcher-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
