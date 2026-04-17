import { useState, useCallback, useEffect } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { PreflightBanner } from './PreflightBanner';
import { GridEngine, useGridEngine } from './GridEngine';
import { openAdHocTerminal } from './AdHocTerminal';
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

function Sidebar(): React.JSX.Element {
  return (
    <div className="region">
      <span className="region-label">File Tree</span>
      <span className="region-sublabel">Sidebar</span>
    </div>
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

interface HostSessionsDrawerProps {
  open: boolean;
  onClose: () => void;
}

function HostSessionsDrawer({ open, onClose }: HostSessionsDrawerProps): React.JSX.Element {
  return (
    <div className={`host-sessions-drawer${open ? '' : ' collapsed'}`}>
      {open && (
        <>
          <div className="drawer-header">
            <span>Host Sessions</span>
            <button className="drawer-toggle" onClick={onClose} title="Close">
              &times;
            </button>
          </div>
          <div className="drawer-content">No sessions</div>
        </>
      )}
    </div>
  );
}

interface StatusBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

function StatusBar({ drawerOpen, onToggleDrawer }: StatusBarProps): React.JSX.Element {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span>Archon Desktop</span>
      </div>
      <div className="status-bar-right">
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
              <Sidebar />
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
        <HostSessionsDrawer open={drawerOpen} onClose={closeDrawer} />
      </div>
      <StatusBar drawerOpen={drawerOpen} onToggleDrawer={toggleDrawer} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
