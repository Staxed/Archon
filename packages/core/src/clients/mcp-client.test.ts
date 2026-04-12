import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { McpToolProvider, McpConnectionError, type McpServerConfig } from './mcp-client';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Test helpers — Fake child process
// ---------------------------------------------------------------------------

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: string) => boolean;
  pid: number;
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.pid = 12345;
  proc.kill = (signal?: string) => {
    proc.killed = true;
    proc.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal ?? 'SIGTERM');
    return true;
  };
  return proc;
}

/** Send a JSON-RPC response through the fake process stdout. */
function sendResponse(proc: FakeProcess, id: number, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  proc.stdout.write(header + msg);
}

// ---------------------------------------------------------------------------
// Intercept stdin writes to detect requests
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Auto-respond to JSON-RPC requests on a fake process.
 * Intercepts stdin writes and responds on stdout.
 */
function autoRespondStdio(
  proc: FakeProcess,
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [],
  toolCallHandler?: (name: string, args: Record<string, unknown>) => unknown
): void {
  const origWrite = proc.stdin.write.bind(proc.stdin);

  proc.stdin.write = ((chunk: Buffer | string, ...rest: unknown[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const bodyStart = str.indexOf('\r\n\r\n');
    if (bodyStart >= 0) {
      try {
        const parsed = JSON.parse(str.slice(bodyStart + 4)) as JsonRpcRequest;

        // Respond asynchronously
        setTimeout(() => {
          if (parsed.method === 'initialize') {
            sendResponse(proc, parsed.id!, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'test-server', version: '1.0.0' },
            });
          } else if (parsed.method === 'tools/list') {
            sendResponse(proc, parsed.id!, { tools });
          } else if (parsed.method === 'tools/call') {
            const params = parsed.params as { name: string; arguments: Record<string, unknown> };
            if (toolCallHandler) {
              sendResponse(proc, parsed.id!, toolCallHandler(params.name, params.arguments));
            } else {
              sendResponse(proc, parsed.id!, {
                content: [{ type: 'text', text: `Result for ${params.name}` }],
              });
            }
          } else if (parsed.method === 'shutdown') {
            sendResponse(proc, parsed.id!, {});
          }
          // notifications/initialized has no id, ignore
        }, 1);
      } catch {
        // Not JSON-RPC, ignore
      }
    }
    return origWrite(chunk, ...(rest as [unknown, unknown]));
  }) as typeof proc.stdin.write;
}

/** Create a fake spawn function that returns a pre-configured fake process. */
function createFakeSpawn(proc: FakeProcess) {
  return (() => proc) as unknown as typeof import('node:child_process').spawn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpToolProvider', () => {
  describe('connect()', () => {
    it('spawns stdio server and enumerates tools', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, [
        {
          name: 'get_weather',
          description: 'Get weather for a location',
          inputSchema: {
            type: 'object',
            properties: { location: { type: 'string', description: 'City name' } },
            required: ['location'],
          },
        },
      ]);

      const provider = new McpToolProvider(
        { weather: { command: 'weather-server', args: ['--stdio'] } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      const defs = provider.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].type).toBe('function');
      expect(defs[0].function.name).toBe('mcp__weather__get_weather');
      expect(defs[0].function.description).toBe('Get weather for a location');
      expect(defs[0].function.parameters.type).toBe('object');
      expect(defs[0].function.parameters.properties.location).toBeDefined();
      expect(defs[0].function.parameters.required).toEqual(['location']);

      await provider.shutdown();
    });

    it('handles multiple tools from one server', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      ]);

      const provider = new McpToolProvider(
        { fs: { command: 'fs-server' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      const defs = provider.getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.function.name)).toEqual(['mcp__fs__read_file', 'mcp__fs__write_file']);

      await provider.shutdown();
    });

    it('handles server with no tools', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, []);

      const provider = new McpToolProvider(
        { empty: { command: 'empty-server' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      expect(provider.getToolDefinitions()).toHaveLength(0);
      await provider.shutdown();
    });

    it('is idempotent on repeated connect() calls', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, []);
      let spawnCallCount = 0;
      const fakeSpawn = (() => {
        spawnCallCount++;
        return proc;
      }) as unknown as typeof import('node:child_process').spawn;

      const provider = new McpToolProvider({ server: { command: 'test' } }, { spawnFn: fakeSpawn });
      await provider.connect();
      await provider.connect(); // Should be a no-op

      expect(spawnCallCount).toBe(1);
      await provider.shutdown();
    });
  });

  describe('callTool()', () => {
    it('dispatches tool call to the correct server', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, [
        {
          name: 'greet',
          description: 'Greet someone',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ]);

      const provider = new McpToolProvider(
        { hello: { command: 'hello-server' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      const result = await provider.callTool('mcp__hello__greet', { name: 'World' });
      expect(result).toBe('Result for greet');

      await provider.shutdown();
    });

    it('throws McpConnectionError for unknown tool names', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, []);

      const provider = new McpToolProvider(
        { server: { command: 'test' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      await expect(provider.callTool('mcp__unknown__tool', {})).rejects.toThrow(McpConnectionError);

      await provider.shutdown();
    });
  });

  describe('env var expansion', () => {
    it('expands env vars in server config', async () => {
      const originalApiKey = process.env.TEST_MCP_API_KEY;
      process.env.TEST_MCP_API_KEY = 'secret-key-123';

      const proc = createFakeProcess();
      autoRespondStdio(proc, []);

      let capturedEnv: Record<string, string> | undefined;
      const fakeSpawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        capturedEnv = opts.env;
        return proc;
      }) as unknown as typeof import('node:child_process').spawn;

      const provider = new McpToolProvider(
        { api: { command: 'api-server', env: { API_KEY: '$TEST_MCP_API_KEY' } } },
        { spawnFn: fakeSpawn }
      );
      await provider.connect();

      expect(capturedEnv!.API_KEY).toBe('secret-key-123');

      await provider.shutdown();

      if (originalApiKey === undefined) {
        delete process.env.TEST_MCP_API_KEY;
      } else {
        process.env.TEST_MCP_API_KEY = originalApiKey;
      }
    });

    it('handles missing env vars gracefully', async () => {
      delete process.env.NONEXISTENT_VAR_FOR_MCP_TEST;

      const proc = createFakeProcess();
      autoRespondStdio(proc, []);

      let capturedEnv: Record<string, string> | undefined;
      const fakeSpawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        capturedEnv = opts.env;
        return proc;
      }) as unknown as typeof import('node:child_process').spawn;

      const provider = new McpToolProvider(
        { api: { command: 'api-server', env: { MISSING: '$NONEXISTENT_VAR_FOR_MCP_TEST' } } },
        { spawnFn: fakeSpawn }
      );
      await provider.connect();

      expect(capturedEnv!.MISSING).toBe('');

      await provider.shutdown();
    });
  });

  describe('McpConnectionError', () => {
    it('includes server name in error message', () => {
      const error = new McpConnectionError('my-server', 'Connection refused');
      expect(error.message).toContain('my-server');
      expect(error.message).toContain('Connection refused');
      expect(error.serverName).toBe('my-server');
      expect(error.name).toBe('McpConnectionError');
    });
  });

  describe('tool schema translation', () => {
    it('translates complex MCP tool schemas to ToolDefinition format', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, [
        {
          name: 'search',
          description: 'Search with filters',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              format: { type: 'string', enum: ['json', 'text', 'csv'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['query'],
          },
        },
      ]);

      const provider = new McpToolProvider(
        { search: { command: 'search-server' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      const defs = provider.getToolDefinitions();
      expect(defs).toHaveLength(1);

      const params = defs[0].function.parameters;
      expect(params.properties.query.type).toBe('string');
      expect(params.properties.query.description).toBe('Search query');
      expect(params.properties.limit.minimum).toBe(1);
      expect(params.properties.limit.maximum).toBe(100);
      expect(params.properties.format.enum).toEqual(['json', 'text', 'csv']);
      expect(params.properties.tags.items?.type).toBe('string');
      expect(params.required).toEqual(['query']);

      await provider.shutdown();
    });
  });

  describe('error handling on tool call', () => {
    it('formats MCP error responses correctly', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(
        proc,
        [
          {
            name: 'fail_tool',
            description: 'A tool that errors',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
        () => ({
          content: [{ type: 'text', text: 'Something went wrong' }],
          isError: true,
        })
      );

      const provider = new McpToolProvider(
        { err: { command: 'err-server' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      const result = await provider.callTool('mcp__err__fail_tool', {});
      expect(result).toBe('[MCP Error] Something went wrong');

      await provider.shutdown();
    });
  });

  describe('shutdown()', () => {
    it('kills all server processes', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, []);

      const provider = new McpToolProvider(
        { server: { command: 'test' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();

      expect(proc.killed).toBe(false);
      await provider.shutdown();
      expect(proc.killed).toBe(true);
    });

    it('clears tool definitions after shutdown', async () => {
      const proc = createFakeProcess();
      autoRespondStdio(proc, [
        {
          name: 'tool1',
          description: 'Test',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ]);

      const provider = new McpToolProvider(
        { server: { command: 'test' } },
        { spawnFn: createFakeSpawn(proc) }
      );
      await provider.connect();
      expect(provider.getToolDefinitions()).toHaveLength(1);

      await provider.shutdown();
      expect(provider.getToolDefinitions()).toHaveLength(0);
    });
  });

  describe('remote (HTTP) transport', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('connects to HTTP MCP server and lists tools', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as { body: string }).body) as JsonRpcRequest;

        if (body.method === 'initialize') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'remote-server', version: '1.0.0' },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (body.method === 'tools/list') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  {
                    name: 'remote_tool',
                    description: 'A remote tool',
                    inputSchema: {
                      type: 'object',
                      properties: { input: { type: 'string' } },
                      required: ['input'],
                    },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {},
          }),
          { status: 200 }
        );
      });

      const provider = new McpToolProvider({
        remote: { type: 'http', url: 'http://localhost:9999/mcp' },
      });
      await provider.connect();

      const defs = provider.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].function.name).toBe('mcp__remote__remote_tool');

      await provider.shutdown();
    });

    it('throws McpConnectionError on HTTP failure', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const provider = new McpToolProvider({
        broken: { type: 'http', url: 'http://localhost:9999/mcp' },
      });

      await expect(provider.connect()).rejects.toThrow(McpConnectionError);
    });

    it('calls remote tools via fetch', async () => {
      let toolCallReceived = false;

      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as { body: string }).body) as JsonRpcRequest;

        if (body.method === 'initialize') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'test', version: '1.0' },
              },
            }),
            { status: 200 }
          );
        }

        if (body.method === 'tools/list') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  {
                    name: 'do_thing',
                    description: 'Do a thing',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                  },
                ],
              },
            }),
            { status: 200 }
          );
        }

        if (body.method === 'tools/call') {
          toolCallReceived = true;
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { content: [{ type: 'text', text: 'remote result' }] },
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
        });
      });

      const provider = new McpToolProvider({
        remote: { type: 'http', url: 'http://localhost:9999/mcp' },
      });
      await provider.connect();

      const result = await provider.callTool('mcp__remote__do_thing', {});
      expect(result).toBe('remote result');
      expect(toolCallReceived).toBe(true);

      await provider.shutdown();
    });
  });
});
