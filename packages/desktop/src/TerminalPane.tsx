import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Backend abstraction for PTY communication. */
export interface TerminalBackend {
  /** Send user input bytes to the PTY. */
  write(data: string): void;
  /** Resize the PTY to the given dimensions. */
  resize(cols: number, rows: number): void;
  /** Register a handler for PTY output data. Returns a dispose function. */
  onData(handler: (data: string) => void): () => void;
  /** Clean up the backend connection. */
  dispose(): void;
}

/** Creates a local PTY backend using Tauri IPC. */
export function createLocalBackend(ptyId: string): TerminalBackend {
  const listeners: ((data: string) => void)[] = [];
  let unlisten: (() => void) | null = null;

  // Lazy-load Tauri APIs to avoid import errors in non-Tauri environments
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<string>(`pty:output:${ptyId}`, event => {
      // Decode base64 payload from Rust
      const decoded = atob(event.payload);
      for (const handler of listeners) {
        handler(decoded);
      }
    }).then(u => {
      unlisten = u;
    });
  });

  return {
    write(data: string): void {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('pty_write', { ptyId, bytes: btoa(data) });
      });
    },
    resize(cols: number, rows: number): void {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('pty_resize', { ptyId, cols, rows });
      });
    },
    onData(handler: (data: string) => void): () => void {
      listeners.push(handler);
      return () => {
        const idx = listeners.indexOf(handler);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    dispose(): void {
      if (unlisten) unlisten();
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('pty_kill', { ptyId });
      });
    },
  };
}

/** Creates a remote PTY backend over WebSocket. */
export function createRemoteBackend(wsUrl: string): TerminalBackend {
  const listeners: ((data: string) => void)[] = [];
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('message', (event: MessageEvent) => {
    let data: string;
    if (event.data instanceof ArrayBuffer) {
      data = new TextDecoder().decode(event.data);
    } else {
      data = event.data as string;
    }
    for (const handler of listeners) {
      handler(data);
    }
  });

  return {
    write(data: string): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    resize(cols: number, rows: number): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    },
    onData(handler: (data: string) => void): () => void {
      listeners.push(handler);
      return () => {
        const idx = listeners.indexOf(handler);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    dispose(): void {
      ws.close();
    },
  };
}

export interface TerminalPaneProps {
  /** The PTY backend to use for this pane. */
  backend: TerminalBackend;
}

/**
 * TerminalPane wraps an xterm.js Terminal instance with WebGL rendering
 * and auto-fit sizing. Supports local and remote PTY backends.
 */
export function TerminalPane({ backend }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (fitAddon && terminal) {
      fitAddon.fit();
      backend.resize(terminal.cols, terminal.rows);
    }
  }, [backend]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      scrollback: 10000,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(container);

    // Try to load WebGL addon — falls back to canvas renderer if unavailable
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available — canvas renderer is the automatic fallback
    }

    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Wire backend output → terminal
    const disposeOnData = backend.onData(data => {
      terminal.write(data);
    });

    // Wire terminal input → backend
    const disposeOnInput = terminal.onData(data => {
      backend.write(data);
    });

    // Send initial size to backend
    backend.resize(terminal.cols, terminal.rows);

    // Observe container resizes
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    return (): void => {
      resizeObserver.disconnect();
      disposeOnInput.dispose();
      disposeOnData();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [backend, handleResize]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  );
}
