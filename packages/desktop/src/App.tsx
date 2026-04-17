import { useState, useCallback, useEffect, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type {
  PanelImperativeHandle,
  GroupImperativeHandle,
  Layout,
  PanelSize,
} from 'react-resizable-panels';
import { PreflightBanner } from './PreflightBanner';
import { GridEngine, useGridEngine } from './GridEngine';
import type { GridPane } from './GridEngine';
import { openAdHocTerminal } from './AdHocTerminal';
import { FileTree } from './FileTree';
import type { TreeRoot } from './FileTree';
import { AddFolderModal, loadWorkspace, removeRootFromWorkspace } from './AddFolderModal';
import { HostSessionsPanel } from './HostSessionsPanel';
import { ProfileEditor } from './ProfileEditor';
import { launchProfile } from './ProfileLauncher';
import { AgentPresetsEditor } from './AgentPresetsEditor';
import {
  EditorColumnContent,
  snapWidth,
  loadEditorColumnState,
  saveEditorColumnState,
} from './EditorColumn';
import './styles.css';

/** Default server URL — overridden once SSH tunnel is established. */
const DEFAULT_SERVER_URL = 'http://localhost:3090';

function ResizeHandle(): React.JSX.Element {
  return (
    <Separator className="resize-handle" style={{ width: 4 }}>
      <div className="resize-handle-bar" />
    </Separator>
  );
}

interface TerminalGridProps {
  gridState: ReturnType<typeof useGridEngine>['state'];
  gridDispatch: ReturnType<typeof useGridEngine>['dispatch'];
}

function TerminalGrid({ gridState, gridDispatch }: TerminalGridProps): React.JSX.Element {
  return <GridEngine state={gridState} dispatch={gridDispatch} />;
}

/** Saved SSH hosts for the Host Sessions panel. */
const SAVED_HOSTS = ['linux-beast'];

interface StatusBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onOpenProfiles: () => void;
  onOpenAgents: () => void;
}

function StatusBar({
  drawerOpen,
  onToggleDrawer,
  onOpenProfiles,
  onOpenAgents,
}: StatusBarProps): React.JSX.Element {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span>Archon Desktop</span>
      </div>
      <div className="status-bar-right">
        <button className="status-bar-btn" onClick={onOpenAgents} title="Agent Presets">
          Agents
        </button>
        <button className="status-bar-btn" onClick={onOpenProfiles} title="Launch Profiles">
          Profiles
        </button>
        <button
          className="status-bar-btn"
          onClick={onToggleDrawer}
          title={drawerOpen ? 'Hide Host Sessions' : 'Show Host Sessions'}
        >
          {drawerOpen ? 'Hide Sessions' : 'Sessions'}
        </button>
      </div>
    </div>
  );
}

/** Primary host alias used for ad-hoc terminals when no project context. */
const PRIMARY_HOST = 'linux-beast';

function App(): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { state: gridState, dispatch: gridDispatch } = useGridEngine();
  const [workspaceRoots, setWorkspaceRoots] = useState<TreeRoot[]>(() => loadWorkspace().roots);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [agentPresetsOpen, setAgentPresetsOpen] = useState(false);

  // Editor column state
  const editorPanelRef = useRef<PanelImperativeHandle>(null);
  const groupRef = useRef<GroupImperativeHandle>(null);
  const [editorCollapsed, setEditorCollapsed] = useState(() => loadEditorColumnState().collapsed);
  const savedEditorWidth = useRef(loadEditorColumnState().width);
  // Track the last expanded width for restoring after collapse
  const lastExpandedWidthRef = useRef(savedEditorWidth.current);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen(prev => !prev);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  // Editor column: toggle collapse/expand
  const handleToggleEditorCollapse = useCallback((): void => {
    const panel = editorPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, []);

  // Editor column: snap after resize ends (Group's onLayoutChanged fires on pointer release)
  const handleLayoutChanged = useCallback((layout: Layout): void => {
    const editorSize = layout.editor;
    if (editorSize === undefined) return;
    const panel = editorPanelRef.current;
    if (!panel) return;

    if (panel.isCollapsed()) {
      setEditorCollapsed(true);
      saveEditorColumnState({ collapsed: true, width: lastExpandedWidthRef.current });
      return;
    }

    setEditorCollapsed(false);
    const snapped = snapWidth(editorSize);
    if (Math.abs(snapped - editorSize) > 0.5) {
      panel.resize(`${snapped}%`);
    }
    lastExpandedWidthRef.current = snapped;
    saveEditorColumnState({ collapsed: false, width: snapped });
  }, []);

  // Editor column: track resize for detecting collapse
  const handleEditorResize = useCallback((panelSize: PanelSize): void => {
    const panel = editorPanelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    setEditorCollapsed(collapsed);
    if (!collapsed) {
      lastExpandedWidthRef.current = panelSize.asPercentage;
    }
  }, []);

  // Show toast with auto-dismiss
  const showToast = useCallback((message: string): void => {
    setToast(message);
    setTimeout(() => {
      setToast(null);
    }, 3000);
  }, []);

  // Open an ad-hoc terminal in the first free grid slot
  const handleOpenAdHoc = useCallback(
    (host: string, cwd: string): void => {
      const result = openAdHocTerminal(gridState.panes, { host, cwd });
      if (result.kind === 'toast') {
        showToast(result.message);
      } else {
        gridDispatch({ type: 'ADD_PANE', pane: result.pane });
      }
    },
    [gridState.panes, gridDispatch, showToast]
  );

  // Attach a tmux session from Host Sessions panel into the grid
  const handleAttachSession = useCallback(
    (pane: GridPane): void => {
      gridDispatch({ type: 'ADD_PANE', pane });
    },
    [gridDispatch]
  );

  const handleRemoveRoot = useCallback((rootId: string): void => {
    removeRootFromWorkspace(rootId);
    setWorkspaceRoots(prev => prev.filter(r => r.id !== rootId));
  }, []);

  const handleAddRoot = useCallback((root: TreeRoot): void => {
    setWorkspaceRoots(prev => [...prev, root]);
    setAddFolderOpen(false);
  }, []);

  const handleOpenAddFolder = useCallback((): void => {
    setAddFolderOpen(true);
  }, []);

  // Launch a profile: compute panes and add them to the grid
  const handleLaunchProfile = useCallback(
    (profileId: string): void => {
      const result = launchProfile(profileId, gridState.panes);
      if (result.kind === 'error') {
        showToast(result.message);
        return;
      }
      for (const pane of result.panes) {
        gridDispatch({ type: 'ADD_PANE', pane });
      }
      if (result.warning) {
        showToast(result.warning);
      }
      setProfileEditorOpen(false);
    },
    [gridState.panes, gridDispatch, showToast]
  );

  const handleCloseAddFolder = useCallback((): void => {
    setAddFolderOpen(false);
  }, []);

  // Keyboard shortcut: Ctrl+Shift+` opens ad-hoc terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key === '`') {
        e.preventDefault();
        handleOpenAdHoc(PRIMARY_HOST, '$HOME');
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, [handleOpenAdHoc]);

  return (
    <div className="app-shell">
      <PreflightBanner serverUrl={DEFAULT_SERVER_URL} />
      <div className="app-main">
        <div className="app-content">
          <Group
            orientation="horizontal"
            id="app-layout"
            groupRef={groupRef}
            onLayoutChanged={handleLayoutChanged}
          >
            <Panel defaultSize={15} minSize={10} maxSize={30} id="sidebar">
              <FileTree
                serverUrl={DEFAULT_SERVER_URL}
                roots={workspaceRoots}
                onRemoveRoot={handleRemoveRoot}
                onAddRoot={handleOpenAddFolder}
                onToast={showToast}
              />
            </Panel>
            <ResizeHandle />
            <Panel
              defaultSize={savedEditorWidth.current}
              minSize={10}
              maxSize={60}
              collapsible
              collapsedSize="30px"
              id="editor"
              panelRef={editorPanelRef}
              onResize={handleEditorResize}
            >
              <EditorColumnContent
                collapsed={editorCollapsed}
                openFiles={[]}
                onToggleCollapse={handleToggleEditorCollapse}
              />
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={55} minSize={20} id="grid">
              <TerminalGrid gridState={gridState} gridDispatch={gridDispatch} />
            </Panel>
          </Group>
        </div>
        <HostSessionsPanel
          open={drawerOpen}
          onClose={closeDrawer}
          serverUrl={DEFAULT_SERVER_URL}
          hosts={SAVED_HOSTS}
          existingPanes={gridState.panes}
          onAttach={handleAttachSession}
          onToast={showToast}
        />
      </div>
      <StatusBar
        drawerOpen={drawerOpen}
        onToggleDrawer={toggleDrawer}
        onOpenProfiles={(): void => {
          setProfileEditorOpen(true);
        }}
        onOpenAgents={(): void => {
          setAgentPresetsOpen(true);
        }}
      />
      {addFolderOpen && (
        <AddFolderModal
          serverUrl={DEFAULT_SERVER_URL}
          savedHosts={[{ alias: 'linux-beast', label: 'Linux Beast' }]}
          onAdd={handleAddRoot}
          onCancel={handleCloseAddFolder}
        />
      )}
      {profileEditorOpen && (
        <ProfileEditor
          onClose={(): void => {
            setProfileEditorOpen(false);
          }}
          onLaunch={handleLaunchProfile}
        />
      )}
      {agentPresetsOpen && (
        <AgentPresetsEditor
          onClose={(): void => {
            setAgentPresetsOpen(false);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
