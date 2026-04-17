import { useState, useCallback } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { PreflightBanner } from './PreflightBanner';
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

function TerminalGrid(): React.JSX.Element {
  return (
    <div className="region">
      <span className="region-label">Terminal Grid</span>
      <span className="region-sublabel">3 x 6</span>
    </div>
  );
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

function App(): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen(prev => !prev);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

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
              <TerminalGrid />
            </Panel>
          </Group>
        </div>
        <HostSessionsDrawer open={drawerOpen} onClose={closeDrawer} />
      </div>
      <StatusBar drawerOpen={drawerOpen} onToggleDrawer={toggleDrawer} />
    </div>
  );
}

export default App;
