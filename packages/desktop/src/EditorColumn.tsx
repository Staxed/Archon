import { useEffect, useRef, useState, useCallback } from 'react';
import { loadWorkspace, saveWorkspace } from './AddFolderModal';
import type { EditorColumnPersistedState } from './AddFolderModal';
import type { TabState, EditorTab, TabAction } from './EditorTabs';
import { getExtension, extensionToLanguage } from './EditorTabs';

// ── Snap logic ──────────────────────────────────────────────────

/**
 * Snap points as percentages of the panel group.
 * 1× grid-column-width ≈ viewport/6 ≈ 17%
 * 2× ≈ 33%
 * 3× ≈ 50%
 */
export const SNAP_WIDTHS: readonly number[] = [17, 33, 50];

/** How close (in %) the panel must be to a snap point to snap. */
const SNAP_THRESHOLD = 4;

/**
 * Snap a width percentage to the nearest snap point if within threshold.
 * Returns the width unchanged if no snap point is close enough.
 */
export function snapWidth(width: number): number {
  let nearest = SNAP_WIDTHS[0];
  let minDist = Math.abs(width - nearest);
  for (const sw of SNAP_WIDTHS) {
    const dist = Math.abs(width - sw);
    if (dist < minDist) {
      minDist = dist;
      nearest = sw;
    }
  }
  return minDist <= SNAP_THRESHOLD ? nearest : width;
}

// ── Persistence ─────────────────────────────────────────────────

export type { EditorColumnPersistedState };

/**
 * Load editor column state from workspace persistence.
 */
export function loadEditorColumnState(): EditorColumnPersistedState {
  const ws = loadWorkspace();
  if (ws.editorColumn) {
    return ws.editorColumn;
  }
  return { collapsed: false, width: SNAP_WIDTHS[0] };
}

/**
 * Save editor column state to workspace persistence.
 */
export function saveEditorColumnState(state: EditorColumnPersistedState): void {
  const ws = loadWorkspace();
  ws.editorColumn = state;
  saveWorkspace(ws);
}

// ── CodeMirror lazy loading ─────────────────────────────────────

type EditorView = import('@codemirror/view').EditorView;
type Extension = import('@codemirror/state').Extension;

interface CMModules {
  EditorView: typeof import('@codemirror/view').EditorView;
  EditorState: typeof import('@codemirror/state').EditorState;
  basicSetup: Extension;
  javascript: () => Extension;
  python: () => Extension;
  markdown: () => Extension;
  json: () => Extension;
  css: () => Extension;
  html: () => Extension;
  oneDark: Extension;
}

let cmModulesPromise: Promise<CMModules> | null = null;

function loadCMModules(): Promise<CMModules> {
  if (!cmModulesPromise) {
    cmModulesPromise = Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('codemirror'),
      import('@codemirror/lang-javascript'),
      import('@codemirror/lang-python'),
      import('@codemirror/lang-markdown'),
      import('@codemirror/lang-json'),
      import('@codemirror/lang-css'),
      import('@codemirror/lang-html'),
    ]).then(([view, state, cm, jsLang, pyLang, mdLang, jsonLang, cssLang, htmlLang]) => ({
      EditorView: view.EditorView,
      EditorState: state.EditorState,
      basicSetup: cm.basicSetup,
      javascript: jsLang.javascript as () => Extension,
      python: pyLang.python as () => Extension,
      markdown: mdLang.markdown as () => Extension,
      json: jsonLang.json as () => Extension,
      css: cssLang.css as () => Extension,
      html: htmlLang.html as () => Extension,
      oneDark: view.EditorView.theme(
        {
          '&': { backgroundColor: '#1a1a2e', color: '#e0e0e0', height: '100%' },
          '.cm-content': { caretColor: '#58a6ff' },
          '.cm-cursor': { borderLeftColor: '#58a6ff' },
          '.cm-gutters': { backgroundColor: '#16162a', color: '#666', borderRight: 'none' },
          '.cm-activeLine': { backgroundColor: '#1e1e3a' },
          '.cm-activeLineGutter': { backgroundColor: '#1e1e3a' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            backgroundColor: '#264f78',
          },
        },
        { dark: true }
      ),
    }));
  }
  return cmModulesPromise;
}

function getLanguageExtension(lang: string | null, cm: CMModules): Extension | null {
  switch (lang) {
    case 'javascript':
    case 'typescript':
      return cm.javascript();
    case 'python':
      return cm.python();
    case 'markdown':
      return cm.markdown();
    case 'json':
      return cm.json();
    case 'css':
      return cm.css();
    case 'html':
      return cm.html();
    default:
      return null;
  }
}

// ── CodeMirror Editor Component ─────────────────────────────────

interface CodeMirrorEditorProps {
  tab: EditorTab;
  content: string;
  onDirty: (tabId: string) => void;
  onPin: (tabId: string) => void;
}

function CodeMirrorEditor({
  tab,
  content,
  onDirty,
  onPin,
}: CodeMirrorEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tabIdRef = useRef(tab.id);

  useEffect(() => {
    tabIdRef.current = tab.id;
  }, [tab.id]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    let view: EditorView | null = null;

    void loadCMModules().then(cm => {
      if (!el.isConnected) return;

      const lang = extensionToLanguage(getExtension(tab.name));
      const langExt = getLanguageExtension(lang, cm);

      const extensions: Extension[] = [
        cm.basicSetup,
        cm.oneDark,
        cm.EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onDirty(tabIdRef.current);
            onPin(tabIdRef.current);
          }
        }),
      ];
      if (langExt) extensions.push(langExt);

      view = new cm.EditorView({
        state: cm.EditorState.create({
          doc: content,
          extensions,
        }),
        parent: el,
      });
      viewRef.current = view;
    });

    return (): void => {
      if (view) {
        view.destroy();
        view = null;
      }
      viewRef.current = null;
    };
  }, [tab.id]); // Only re-create editor on tab identity change

  return <div ref={containerRef} className="cm-editor-container" />;
}

// ── Tab bar ─────────────────────────────────────────────────────

interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}

function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onContextMenu,
}: TabBarProps): React.JSX.Element {
  return (
    <div className="editor-tab-bar">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`editor-tab ${tab.id === activeTabId ? 'editor-tab-active' : ''} ${tab.preview ? 'editor-tab-preview' : ''}`}
          onClick={(): void => {
            onActivate(tab.id);
          }}
          onDoubleClick={(): void => {
            // Double-click pins preview tabs in the tab bar
          }}
          onContextMenu={(e): void => {
            onContextMenu(e, tab.id);
          }}
          role="tab"
          tabIndex={0}
          title={tab.path}
          onKeyDown={(e): void => {
            if (e.key === 'Enter') onActivate(tab.id);
          }}
        >
          <span className="editor-tab-name">{tab.name}</span>
          {tab.dirty && <span className="editor-tab-dirty">●</span>}
          <button
            className="editor-tab-close"
            onClick={(e): void => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            title="Close tab"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Close-dirty modal ───────────────────────────────────────────

interface CloseDirtyModalProps {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function CloseDirtyModal({
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: CloseDirtyModalProps): React.JSX.Element {
  return (
    <div className="modal-overlay">
      <div className="modal editor-close-dirty-modal">
        <h3>Unsaved Changes</h3>
        <p>
          <strong>{fileName}</strong> has unsaved changes. What would you like to do?
        </p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-primary" onClick={onSave}>
            Save
          </button>
          <button className="modal-btn modal-btn-danger" onClick={onDiscard}>
            Discard
          </button>
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab context menu ────────────────────────────────────────────

interface TabContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

// ── Main component ──────────────────────────────────────────────

export interface OpenFile {
  path: string;
  host: string;
  name: string;
}

interface EditorColumnContentProps {
  collapsed: boolean;
  openFiles: OpenFile[];
  onToggleCollapse: () => void;
  tabState: TabState;
  tabDispatch: (action: TabAction) => void;
  fileContents: Record<string, string>;
  onSplitRight?: (tabId: string) => void;
}

/**
 * Content rendered inside the editor Panel.
 * Shows a thin clickable rail when collapsed (with open-file icons).
 * Shows tabs + CodeMirror editor when expanded.
 */
export function EditorColumnContent({
  collapsed,
  openFiles,
  onToggleCollapse,
  tabState,
  tabDispatch,
  fileContents,
  onSplitRight,
}: EditorColumnContentProps): React.JSX.Element {
  const [closeDirtyTab, setCloseDirtyTab] = useState<EditorTab | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);

  const handleActivate = useCallback(
    (id: string): void => {
      tabDispatch({ type: 'ACTIVATE_TAB', id });
    },
    [tabDispatch]
  );

  const handleClose = useCallback(
    (id: string): void => {
      const tab = tabState.tabs.find(t => t.id === id);
      if (tab?.dirty) {
        setCloseDirtyTab(tab);
        return;
      }
      tabDispatch({ type: 'CLOSE_TAB', id });
    },
    [tabState.tabs, tabDispatch]
  );

  const handleDirty = useCallback(
    (id: string): void => {
      tabDispatch({ type: 'SET_DIRTY', id, dirty: true });
    },
    [tabDispatch]
  );

  const handlePin = useCallback(
    (id: string): void => {
      tabDispatch({ type: 'PIN_TAB', id });
    },
    [tabDispatch]
  );

  const handleTabContextMenu = useCallback((e: React.MouseEvent, id: string): void => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId: id });
  }, []);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (): void => {
      setContextMenu(null);
    };
    window.addEventListener('click', handler);
    return (): void => {
      window.removeEventListener('click', handler);
    };
  }, [contextMenu]);

  if (collapsed) {
    return (
      <div
        className="editor-rail"
        onClick={onToggleCollapse}
        role="button"
        tabIndex={0}
        title="Expand editor column"
        onKeyDown={(e): void => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleCollapse();
          }
        }}
      >
        {openFiles.map(f => (
          <div key={`${f.host}:${f.path}`} className="editor-rail-icon" title={f.name}>
            {f.name.charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
    );
  }

  const activeTab = tabState.tabs.find(t => t.id === tabState.activeTabId) ?? null;

  return (
    <div className="editor-column">
      <div className="editor-column-header">
        {tabState.tabs.length > 0 ? (
          <TabBar
            tabs={tabState.tabs}
            activeTabId={tabState.activeTabId}
            onActivate={handleActivate}
            onClose={handleClose}
            onContextMenu={handleTabContextMenu}
          />
        ) : (
          <span className="editor-column-title">Editor</span>
        )}
        <button
          className="editor-column-collapse-btn"
          onClick={onToggleCollapse}
          title="Collapse editor column"
        >
          ◀
        </button>
      </div>
      <div className="editor-column-body">
        {activeTab ? (
          <CodeMirrorEditor
            key={activeTab.id}
            tab={activeTab}
            content={fileContents[activeTab.id] ?? ''}
            onDirty={handleDirty}
            onPin={handlePin}
          />
        ) : (
          <>
            <span className="region-label">Editor</span>
            <span className="region-sublabel">Open a file to start editing</span>
          </>
        )}
      </div>

      {closeDirtyTab && (
        <CloseDirtyModal
          fileName={closeDirtyTab.name}
          onSave={(): void => {
            // Save will be wired in US-028 — for now just close
            tabDispatch({ type: 'CLOSE_TAB', id: closeDirtyTab.id });
            setCloseDirtyTab(null);
          }}
          onDiscard={(): void => {
            tabDispatch({ type: 'CLOSE_TAB', id: closeDirtyTab.id });
            setCloseDirtyTab(null);
          }}
          onCancel={(): void => {
            setCloseDirtyTab(null);
          }}
        />
      )}

      {contextMenu && (
        <div
          className="editor-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onSplitRight && (
            <button
              className="editor-tab-context-item"
              onClick={(): void => {
                onSplitRight(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              Open in New Split
            </button>
          )}
          <button
            className="editor-tab-context-item"
            onClick={(): void => {
              handleClose(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
