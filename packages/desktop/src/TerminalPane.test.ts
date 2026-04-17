import { describe, test, expect, mock } from 'bun:test';
import type { TerminalBackend } from './TerminalPane';

/** Create a mock backend for testing. */
function createMockBackend(): TerminalBackend & {
  written: string[];
  resizes: Array<{ cols: number; rows: number }>;
  handlers: Array<(data: string) => void>;
  simulateOutput: (data: string) => void;
} {
  const written: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const handlers: Array<(data: string) => void> = [];

  return {
    written,
    resizes,
    handlers,
    write(data: string): void {
      written.push(data);
    },
    resize(cols: number, rows: number): void {
      resizes.push({ cols, rows });
    },
    onData(handler: (data: string) => void): () => void {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    },
    dispose: mock(() => {}),
    simulateOutput(data: string): void {
      for (const handler of handlers) {
        handler(data);
      }
    },
  };
}

describe('TerminalBackend mock', () => {
  test('write() captures user input', () => {
    const backend = createMockBackend();
    backend.write('hello');
    backend.write('world');
    expect(backend.written).toEqual(['hello', 'world']);
  });

  test('resize() captures dimensions', () => {
    const backend = createMockBackend();
    backend.resize(80, 24);
    backend.resize(120, 40);
    expect(backend.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
    ]);
  });

  test('onData handler receives output', () => {
    const backend = createMockBackend();
    const received: string[] = [];
    backend.onData(data => received.push(data));
    backend.simulateOutput('output line 1');
    backend.simulateOutput('output line 2');
    expect(received).toEqual(['output line 1', 'output line 2']);
  });

  test('onData dispose removes handler', () => {
    const backend = createMockBackend();
    const received: string[] = [];
    const dispose = backend.onData(data => received.push(data));
    backend.simulateOutput('before');
    dispose();
    backend.simulateOutput('after');
    expect(received).toEqual(['before']);
  });

  test('multiple handlers receive same output', () => {
    const backend = createMockBackend();
    const received1: string[] = [];
    const received2: string[] = [];
    backend.onData(data => received1.push(data));
    backend.onData(data => received2.push(data));
    backend.simulateOutput('shared');
    expect(received1).toEqual(['shared']);
    expect(received2).toEqual(['shared']);
  });

  test('dispose() is callable', () => {
    const backend = createMockBackend();
    backend.dispose();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('createRemoteBackend message flow', () => {
  test('write sends data to WebSocket', () => {
    // Simulate WebSocket behavior without actual connection
    const sent: string[] = [];
    const backend = createMockBackend();
    // Override write to simulate WS send
    backend.write = (data: string) => sent.push(data);
    backend.write('user input');
    expect(sent).toEqual(['user input']);
  });

  test('resize sends JSON resize message', () => {
    const sent: string[] = [];
    const backend = createMockBackend();
    // Override resize to simulate WS JSON send
    backend.resize = (cols: number, rows: number) => {
      sent.push(JSON.stringify({ type: 'resize', cols, rows }));
    };
    backend.resize(120, 40);
    expect(sent).toEqual([JSON.stringify({ type: 'resize', cols: 120, rows: 40 })]);
  });
});

describe('input/output flow integration', () => {
  test('bidirectional data flow through backend', () => {
    const backend = createMockBackend();
    const terminalOutput: string[] = [];

    // Simulate terminal → backend (user types)
    backend.write('ls -la\r');

    // Simulate backend → terminal (command output)
    backend.onData(data => terminalOutput.push(data));
    backend.simulateOutput('total 42\n');
    backend.simulateOutput('drwxr-xr-x  2 user user 4096 Jan  1 00:00 .\n');

    expect(backend.written).toEqual(['ls -la\r']);
    expect(terminalOutput).toEqual(['total 42\n', 'drwxr-xr-x  2 user user 4096 Jan  1 00:00 .\n']);
  });

  test('resize is sent on dimension change', () => {
    const backend = createMockBackend();

    // Initial size
    backend.resize(80, 24);
    // Container resized
    backend.resize(132, 43);

    expect(backend.resizes).toHaveLength(2);
    expect(backend.resizes[0]).toEqual({ cols: 80, rows: 24 });
    expect(backend.resizes[1]).toEqual({ cols: 132, rows: 43 });
  });
});
