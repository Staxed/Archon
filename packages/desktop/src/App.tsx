import { useState, useCallback, useEffect } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
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

function EditorColumn(): React.JSX.Element {
  return (
    <div className="region">
      <span className="region-label">Editor</span>
      <span className="region-sublabel">Column</span>
    </div>
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
}

function StatusBar({
  drawerOpen,
  onToggleDrawer,
  onOpenProfiles,
}: StatusBarProps): React.JSX.Element {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span>Archon Desktop</span>
      </div>
      <div className="status-bar-right">
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

  const toggleDrawer = useCallback(() => {
    setDrawerOpen(prev => !prev);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
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
          <Group orientation="horizontal" id="app-layout">
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
            <Panel defaultSize={30} minSize={10} maxSize={60} id="editor">
              <EditorColumn />
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
