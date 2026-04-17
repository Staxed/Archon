import { useEffect, useRef, useState, useCallback } from 'react';
import { loadWorkspace, saveWorkspace } from './AddFolderModal';
import type { EditorColumnPersistedState } from './AddFolderModal';
import type { TabState, EditorTab, TabAction, SplitState, SplitAction } from './EditorTabs';
import { getExtension, extensionToLanguage, getAllSplitTabs } from './EditorTabs';
import {
  fileExtToLspLanguage,
  buildLspWsUri,
  deriveProjectDir,
  getFileExtension,
} from './LspClient';

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
  languageServer: typeof import('codemirror-languageserver').languageServer;
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
      import('codemirror-languageserver'),
    ]).then(([view, state, cm, jsLang, pyLang, mdLang, jsonLang, cssLang, htmlLang, lspMod]) => ({
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
      languageServer: lspMod.languageServer,
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

/** Map of tab id → EditorView for reading current content from parent. */
const editorViewMap = new Map<string, EditorView>();

/** Get the current document content for a tab from its CodeMirror EditorView. */
export function getEditorContent(tabId: string): string | null {
  const view = editorViewMap.get(tabId);
  if (!view) return null;
  return view.state.doc.toString();
}

/** Replace the document content in a tab's CodeMirror EditorView. */
export function replaceEditorContent(tabId: string, newContent: string): void {
  const view = editorViewMap.get(tabId);
  if (!view) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: newContent },
  });
}

/** Default server base URL for LSP connections. */
const DEFAULT_SERVER_BASE_URL = 'http://localhost:3090';

interface CodeMirrorEditorProps {
  tab: EditorTab;
  content: string;
  onDirty: (tabId: string) => void;
  onPin: (tabId: string) => void;
  serverBaseUrl?: string;
}

function CodeMirrorEditor({
  tab,
  content,
  onDirty,
  onPin,
  serverBaseUrl,
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

      const ext = getFileExtension(tab.path) || getExtension(tab.name);
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

      // Add LSP support if the language is supported
      const lspLang = fileExtToLspLanguage(ext);
      if (lspLang) {
        try {
          const base = serverBaseUrl || DEFAULT_SERVER_BASE_URL;
          const projectDir = deriveProjectDir(tab.path);
          const wsUri = buildLspWsUri(base, lspLang, projectDir);
          const lspExts = cm.languageServer({
            serverUri: wsUri as `ws://${string}`,
            rootUri: `file://${projectDir}`,
            workspaceFolders: [
              { uri: `file://${projectDir}`, name: projectDir.split('/').pop() || 'workspace' },
            ],
            documentUri: `file://${tab.path}`,
            languageId: lspLang,
          });
          extensions.push(...lspExts);
        } catch {
          // LSP connection failed — editor works without LSP features
        }
      }

      view = new cm.EditorView({
        state: cm.EditorState.create({
          doc: content,
          extensions,
        }),
        parent: el,
      });
      viewRef.current = view;
      editorViewMap.set(tab.id, view);
    });

    return (): void => {
      editorViewMap.delete(tab.id);
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

// ── Conflict banner ────────────────────────────────────────────

interface ConflictBannerProps {
  fileName: string;
  onReload: () => void;
  onOverwrite: () => void;
}

function ConflictBanner({
  fileName,
  onReload,
  onOverwrite,
}: ConflictBannerProps): React.JSX.Element {
  return (
    <div className="editor-conflict-banner">
      <span>
        <strong>{fileName}</strong> was changed on disk. Your edits may conflict.
      </span>
      <div className="editor-conflict-actions">
        <button className="modal-btn" onClick={onReload}>
          Reload
        </button>
        <button className="modal-btn modal-btn-danger" onClick={onOverwrite}>
          Overwrite anyway
        </button>
      </div>
    </div>
  );
}

// ── Window close dirty modal ───────────────────────────────────

interface WindowCloseDirtyModalProps {
  dirtyFiles: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

function WindowCloseDirtyModal({
  dirtyFiles,
  onConfirm,
  onCancel,
}: WindowCloseDirtyModalProps): React.JSX.Element {
  return (
    <div className="modal-overlay">
      <div className="modal editor-close-dirty-modal">
        <h3>Unsaved Changes</h3>
        <p>The following files have unsaved changes:</p>
        <ul className="editor-dirty-file-list">
          {dirtyFiles.map(f => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p>Close anyway and discard all changes?</p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-danger" onClick={onConfirm}>
            Discard All &amp; Close
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

export interface ConflictState {
  tabId: string;
  fileName: string;
  currentContent: string;
  currentMtime: string;
}

interface EditorColumnContentProps {
  collapsed: boolean;
  openFiles: OpenFile[];
  onToggleCollapse: () => void;
  splitState: SplitState;
  splitDispatch: (action: SplitAction) => void;
  fileContents: Record<string, string>;
  onSaveTab?: (tabId: string) => void;
  conflict?: ConflictState | null;
  onConflictReload?: () => void;
  onConflictOverwrite?: () => void;
  windowCloseDirtyFiles?: string[] | null;
  onWindowCloseConfirm?: () => void;
  onWindowCloseCancel?: () => void;
  serverBaseUrl?: string;
}

// ── Single split pane ──────────────────────────────────────────

interface SplitPaneProps {
  splitIndex: number;
  tabState: TabState;
  isActive: boolean;
  splitDispatch: (action: SplitAction) => void;
  fileContents: Record<string, string>;
  onSaveTab?: (tabId: string) => void;
  onSplitRight: (tabId: string) => void;
  serverBaseUrl?: string;
}

function SplitPane({
  splitIndex,
  tabState,
  isActive,
  splitDispatch,
  fileContents,
  onSaveTab,
  onSplitRight,
  serverBaseUrl,
}: SplitPaneProps): React.JSX.Element {
  const [closeDirtyTab, setCloseDirtyTab] = useState<EditorTab | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);

  const dispatchTab = useCallback(
    (action: TabAction): void => {
      splitDispatch({ type: 'SPLIT_TAB', splitIndex, action });
    },
    [splitDispatch, splitIndex]
  );

  const handleActivate = useCallback(
    (id: string): void => {
      splitDispatch({ type: 'ACTIVATE_SPLIT', splitIndex });
      dispatchTab({ type: 'ACTIVATE_TAB', id });
    },
    [splitDispatch, splitIndex, dispatchTab]
  );

  const handleClose = useCallback(
    (id: string): void => {
      const tab = tabState.tabs.find(t => t.id === id);
      if (tab?.dirty) {
        setCloseDirtyTab(tab);
        return;
      }
      dispatchTab({ type: 'CLOSE_TAB', id });
    },
    [tabState.tabs, dispatchTab]
  );

  const handleDirty = useCallback(
    (id: string): void => {
      dispatchTab({ type: 'SET_DIRTY', id, dirty: true });
    },
    [dispatchTab]
  );

  const handlePin = useCallback(
    (id: string): void => {
      dispatchTab({ type: 'PIN_TAB', id });
    },
    [dispatchTab]
  );

  const handleTabContextMenu = useCallback((e: React.MouseEvent, id: string): void => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId: id });
  }, []);

  const handleFocus = useCallback((): void => {
    splitDispatch({ type: 'ACTIVATE_SPLIT', splitIndex });
  }, [splitDispatch, splitIndex]);

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

  const activeTab = tabState.tabs.find(t => t.id === tabState.activeTabId) ?? null;

  return (
    <div
      className={`editor-split-pane ${isActive ? 'editor-split-pane-active' : ''}`}
      onClick={handleFocus}
      role="presentation"
    >
      <TabBar
        tabs={tabState.tabs}
        activeTabId={tabState.activeTabId}
        onActivate={handleActivate}
        onClose={handleClose}
        onContextMenu={handleTabContextMenu}
      />
      <div className="editor-split-body">
        {activeTab ? (
          <CodeMirrorEditor
            key={activeTab.id}
            tab={activeTab}
            content={fileContents[activeTab.id] ?? ''}
            onDirty={handleDirty}
            onPin={handlePin}
            serverBaseUrl={serverBaseUrl}
          />
        ) : (
          <div className="editor-split-empty">
            <span className="region-sublabel">No open file</span>
          </div>
        )}
      </div>

      {closeDirtyTab && (
        <CloseDirtyModal
          fileName={closeDirtyTab.name}
          onSave={(): void => {
            if (onSaveTab) {
              onSaveTab(closeDirtyTab.id);
            }
            dispatchTab({ type: 'CLOSE_TAB', id: closeDirtyTab.id });
            setCloseDirtyTab(null);
          }}
          onDiscard={(): void => {
            dispatchTab({ type: 'CLOSE_TAB', id: closeDirtyTab.id });
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
          <button
            className="editor-tab-context-item"
            onClick={(): void => {
              onSplitRight(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            Open in New Split
          </button>
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

// ── Main component ──────────────────────────────────────────────

/**
 * Content rendered inside the editor Panel.
 * Shows a thin clickable rail when collapsed (with open-file icons).
 * Shows one or more side-by-side split panes when expanded.
 */
export function EditorColumnContent({
  collapsed,
  openFiles,
  onToggleCollapse,
  splitState,
  splitDispatch,
  fileContents,
  onSaveTab,
  conflict,
  onConflictReload,
  onConflictOverwrite,
  windowCloseDirtyFiles,
  onWindowCloseConfirm,
  onWindowCloseCancel,
  serverBaseUrl,
}: EditorColumnContentProps): React.JSX.Element {
  const handleSplitRight = useCallback(
    (id: string): void => {
      splitDispatch({ type: 'SPLIT_RIGHT', tabId: id });
    },
    [splitDispatch]
  );

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

  const allTabs = getAllSplitTabs(splitState);
  const hasTabs = allTabs.length > 0;

  return (
    <div className="editor-column">
      <div className="editor-column-header">
        {hasTabs ? (
          <span className="editor-column-title">
            Editor{splitState.splits.length > 1 ? ` (${splitState.splits.length} splits)` : ''}
          </span>
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
      <div className="editor-column-body editor-column-splits">
        {hasTabs ? (
          splitState.splits.map((split, idx) => (
            <SplitPane
              key={idx}
              splitIndex={idx}
              tabState={split}
              isActive={idx === splitState.activeSplitIndex}
              splitDispatch={splitDispatch}
              fileContents={fileContents}
              onSaveTab={onSaveTab}
              onSplitRight={handleSplitRight}
              serverBaseUrl={serverBaseUrl}
            />
          ))
        ) : (
          <>
            <span className="region-label">Editor</span>
            <span className="region-sublabel">Open a file to start editing</span>
          </>
        )}
      </div>

      {conflict && onConflictReload && onConflictOverwrite && (
        <ConflictBanner
          fileName={conflict.fileName}
          onReload={onConflictReload}
          onOverwrite={onConflictOverwrite}
        />
      )}

      {windowCloseDirtyFiles &&
        windowCloseDirtyFiles.length > 0 &&
        onWindowCloseConfirm &&
        onWindowCloseCancel && (
          <WindowCloseDirtyModal
            dirtyFiles={windowCloseDirtyFiles}
            onConfirm={onWindowCloseConfirm}
            onCancel={onWindowCloseCancel}
          />
        )}
    </div>
  );
}
