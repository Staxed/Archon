/**
 * MCP client wrapper that spawns MCP servers and translates their tools
 * to OpenAI function-call format for use by non-Claude providers.
 *
 * Supports stdio, SSE, and HTTP transport types matching the MCP config
 * format used in workflow YAML.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@archon/paths';
import type { ToolDefinition, JSONSchemaObject, JSONSchemaProperty } from './tool-definitions';

const log = createLogger('mcp-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** MCP server config matching the format used in workflow YAML and dag-executor. */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

/** Result of listing tools from an MCP server. */
interface McpToolInfo {
  /** Server name (key from the config record). */
  serverName: string;
  /** Tool name as reported by the MCP server. */
  name: string;
  /** Tool description. */
  description: string;
  /** JSON Schema for tool parameters (inputSchema from MCP). */
  inputSchema: Record<string, unknown>;
}

/** A connected MCP server with its client and child process (if stdio). */
interface ConnectedServer {
  serverName: string;
  config: McpServerConfig;
  process: ChildProcess | null;
  requestId: number;
  pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >;
  buffer: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio helpers
// ---------------------------------------------------------------------------

/** Send a JSON-RPC 2.0 request over stdin and return a promise for the response. */
function sendRequest(
  server: ConnectedServer,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const stdin = server.process?.stdin;
  if (!stdin?.writable) {
    return Promise.reject(
      new McpConnectionError(server.serverName, 'Server process stdin is not writable')
    );
  }

  const id = ++server.requestId;
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: params ?? {},
  });

  return new Promise((resolve, reject) => {
    server.pendingRequests.set(id, { resolve, reject });

    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    stdin.write(content, err => {
      if (err) {
        server.pendingRequests.delete(id);
        reject(
          new McpConnectionError(server.serverName, `Failed to write to stdin: ${err.message}`)
        );
      }
    });
  });
}

/** Parse JSON-RPC responses from the stdio buffer. */
function processBuffer(server: ConnectedServer): void {
  while (true) {
    const headerEnd = server.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerSection = server.buffer.slice(0, headerEnd);
    const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerSection);
    if (!contentLengthMatch) {
      // Skip malformed header
      server.buffer = server.buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;

    if (server.buffer.length < bodyStart + contentLength) break;

    const body = server.buffer.slice(bodyStart, bodyStart + contentLength);
    server.buffer = server.buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body) as {
        jsonrpc: string;
        id?: number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
        method?: string;
      };

      if (msg.id !== undefined) {
        const pending = server.pendingRequests.get(msg.id);
        if (!pending) continue;
        server.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(
            new McpConnectionError(
              server.serverName,
              `MCP server error (${msg.error.code}): ${msg.error.message}`
            )
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      // Notifications (no id) are silently ignored
    } catch {
      log.warn({ serverName: server.serverName }, 'mcp.json_parse_failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Env var expansion (matching dag-executor.ts pattern)
// ---------------------------------------------------------------------------

/** Expand $VAR_NAME references in string values from process.env. */
function expandEnvVarsInRecord(
  record: Record<string, string>,
  missingVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    result[key] = val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        missingVars.push(varName);
      }
      return envVal ?? '';
    });
  }
  return result;
}

/** Expand env vars in an MCP server config, returning missing var names. */
function expandServerConfig(config: McpServerConfig): {
  expanded: McpServerConfig;
  missingVars: string[];
} {
  const missingVars: string[] = [];
  const expanded = { ...config };

  if ('env' in expanded && expanded.env) {
    expanded.env = expandEnvVarsInRecord(expanded.env, missingVars);
  }
  if ('headers' in expanded && expanded.headers) {
    expanded.headers = expandEnvVarsInRecord(expanded.headers, missingVars);
  }

  return { expanded, missingVars };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Classified error for MCP server connection failures. */
export class McpConnectionError extends Error {
  readonly serverName: string;

  constructor(serverName: string, message: string) {
    super(`MCP server '${serverName}': ${message}`);
    this.name = 'McpConnectionError';
    this.serverName = serverName;
  }
}

// ---------------------------------------------------------------------------
// MCP tool schema translation
// ---------------------------------------------------------------------------

/**
 * Translate an MCP tool's inputSchema to the ToolDefinition JSON Schema format.
 * MCP tools use standard JSON Schema for inputSchema; we normalize to our typed format.
 */
function translateInputSchema(inputSchema: Record<string, unknown>): JSONSchemaObject {
  const properties: Record<string, JSONSchemaProperty> = {};
  const rawProperties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const [propName, propSchema] of Object.entries(rawProperties)) {
    properties[propName] = translateProperty(propSchema);
  }

  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: inputSchema.additionalProperties === true ? true : false,
  };
}

/** Translate a single JSON Schema property from MCP format. */
function translateProperty(prop: Record<string, unknown>): JSONSchemaProperty {
  const result: JSONSchemaProperty = {
    type: typeof prop.type === 'string' ? prop.type : 'string',
  };

  if (typeof prop.description === 'string') result.description = prop.description;
  if (Array.isArray(prop.enum)) result.enum = prop.enum as string[];
  if (prop.default !== undefined) result.default = prop.default as string | number | boolean;
  if (typeof prop.minimum === 'number') result.minimum = prop.minimum;
  if (typeof prop.maximum === 'number') result.maximum = prop.maximum;
  if (typeof prop.exclusiveMinimum === 'number') result.exclusiveMinimum = prop.exclusiveMinimum;
  if (prop.items && typeof prop.items === 'object') {
    result.items = translateProperty(prop.items as Record<string, unknown>);
  }

  return result;
}

/** Convert an MCP tool to an OpenAI function-call ToolDefinition. */
function mcpToolToDefinition(serverName: string, tool: McpToolInfo): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${tool.name}`,
      description: tool.description || `MCP tool '${tool.name}' from server '${serverName}'`,
      parameters: translateInputSchema(tool.inputSchema),
    },
  };
}

// ---------------------------------------------------------------------------
// McpToolProvider
// ---------------------------------------------------------------------------

/** Timeout for server initialization (ms). */
const INIT_TIMEOUT_MS = 30_000;

/**
 * Manages MCP server connections and provides tools in OpenAI function-call format.
 *
 * Usage:
 * ```typescript
 * const provider = new McpToolProvider(mcpConfigs);
 * await provider.connect();
 * const tools = provider.getToolDefinitions();
 * const result = await provider.callTool('mcp__server__toolName', { arg: 'value' });
 * await provider.shutdown();
 * ```
 */
/** Options for McpToolProvider constructor. */
export interface McpToolProviderOptions {
  /** Override spawn function for testing. Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
}

export class McpToolProvider {
  private readonly configs: Record<string, McpServerConfig>;
  private readonly servers: Map<string, ConnectedServer> = new Map();
  private readonly toolMap: Map<string, { serverName: string; mcpToolName: string }> = new Map();
  private readonly spawnFn: typeof spawn;
  private toolDefs: ToolDefinition[] = [];
  private connected = false;

  constructor(configs: Record<string, McpServerConfig>, options?: McpToolProviderOptions) {
    this.configs = configs;
    this.spawnFn = options?.spawnFn ?? spawn;
  }

  /**
   * Connect to all configured MCP servers, enumerate their tools,
   * and build the merged tool list.
   *
   * Throws McpConnectionError if any server fails to connect.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const allTools: ToolDefinition[] = [];

    for (const [serverName, rawConfig] of Object.entries(this.configs)) {
      const { expanded: config, missingVars } = expandServerConfig(rawConfig);

      if (missingVars.length > 0) {
        log.warn({ serverName, missingVars }, 'mcp.server_missing_env_vars');
      }

      const serverType = getServerType(config);

      if (serverType === 'stdio') {
        const stdioCfg = config as {
          type?: 'stdio';
          command: string;
          args?: string[];
          env?: Record<string, string>;
        };
        const server = await this.connectStdio(serverName, stdioCfg);
        const tools = await this.listServerTools(server);

        for (const tool of tools) {
          const def = mcpToolToDefinition(serverName, tool);
          allTools.push(def);
          this.toolMap.set(def.function.name, { serverName, mcpToolName: tool.name });
        }
      } else {
        // SSE and HTTP transports — use fetch-based JSON-RPC
        const remoteCfg = config as {
          type: 'sse' | 'http';
          url: string;
          headers?: Record<string, string>;
        };
        const tools = await this.listRemoteTools(serverName, remoteCfg);

        for (const tool of tools) {
          const def = mcpToolToDefinition(serverName, tool);
          allTools.push(def);
          this.toolMap.set(def.function.name, { serverName, mcpToolName: tool.name });
        }
      }
    }

    this.toolDefs = allTools;
    this.connected = true;

    log.info(
      { serverCount: Object.keys(this.configs).length, toolCount: allTools.length },
      'mcp.connect_completed'
    );
  }

  /** Get all tool definitions from connected MCP servers. */
  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefs;
  }

  /**
   * Call an MCP tool by its qualified name (mcp__serverName__toolName).
   * Returns the tool result as a string.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const mapping = this.toolMap.get(qualifiedName);
    if (!mapping) {
      throw new McpConnectionError('unknown', `Unknown MCP tool: ${qualifiedName}`);
    }

    const { serverName, mcpToolName } = mapping;
    const server = this.servers.get(serverName);

    if (server) {
      // Stdio server — use JSON-RPC
      const result = (await sendRequest(server, 'tools/call', {
        name: mcpToolName,
        arguments: args,
      })) as { content?: { type: string; text?: string }[]; isError?: boolean };

      return formatToolResult(result);
    }

    // Remote server — check if we still have config
    const rawConfig = this.configs[serverName];
    if (!rawConfig) {
      throw new McpConnectionError(serverName, 'Server not found');
    }

    const { expanded: config } = expandServerConfig(rawConfig);
    const remoteCfg = config as {
      type: 'sse' | 'http';
      url: string;
      headers?: Record<string, string>;
    };
    return this.callRemoteTool(serverName, remoteCfg, mcpToolName, args);
  }

  /** Shut down all connected servers and child processes. */
  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const [serverName, server] of this.servers) {
      shutdownPromises.push(
        this.shutdownServer(serverName, server).catch((err: unknown) => {
          const error = err as Error;
          log.warn({ serverName, error: error.message }, 'mcp.server_shutdown_error');
        })
      );
    }

    await Promise.all(shutdownPromises);
    this.servers.clear();
    this.toolMap.clear();
    this.toolDefs = [];
    this.connected = false;

    log.info('mcp.shutdown_completed');
  }

  // -------------------------------------------------------------------------
  // Stdio transport
  // -------------------------------------------------------------------------

  private async connectStdio(
    serverName: string,
    config: { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  ): Promise<ConnectedServer> {
    const childEnv = config.env ? { ...getInheritedEnv(), ...config.env } : getInheritedEnv();

    let child: ChildProcess;
    try {
      child = this.spawnFn(config.command, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (err) {
      const error = err as Error;
      throw new McpConnectionError(
        serverName,
        `Failed to spawn command '${config.command}': ${error.message}`
      );
    }

    const server: ConnectedServer = {
      serverName,
      config,
      process: child,
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
    };

    this.servers.set(serverName, server);

    // stdio: ['pipe', 'pipe', 'pipe'] guarantees stdout/stderr are streams
    const childStdout = child.stdout;
    const childStderr = child.stderr;

    // Wire up stdout for JSON-RPC response parsing
    if (childStdout) {
      childStdout.on('data', (chunk: Buffer) => {
        server.buffer += chunk.toString();
        processBuffer(server);
      });
    }

    if (childStderr) {
      childStderr.on('data', (chunk: Buffer) => {
        log.debug({ serverName, stderr: chunk.toString().trim() }, 'mcp.server_stderr');
      });
    }

    child.on('error', err => {
      log.error({ serverName, error: err.message }, 'mcp.server_process_error');
      // Reject all pending requests and remove stale server entry
      for (const [, pending] of server.pendingRequests) {
        pending.reject(new McpConnectionError(serverName, `Process error: ${err.message}`));
      }
      server.pendingRequests.clear();
      this.servers.delete(serverName);
      if (server.process && !server.process.killed) {
        server.process.kill('SIGKILL');
      }
    });

    child.on('exit', (code, signal) => {
      log.info({ serverName, code, signal }, 'mcp.server_process_exit');
      // Reject all pending requests and remove stale server entry
      for (const [, pending] of server.pendingRequests) {
        pending.reject(
          new McpConnectionError(serverName, `Process exited (code=${code}, signal=${signal})`)
        );
      }
      server.pendingRequests.clear();
      this.servers.delete(serverName);
    });

    // Initialize the MCP session
    await this.initializeStdioSession(server);

    return server;
  }

  private async initializeStdioSession(server: ConnectedServer): Promise<void> {
    const initPromise = sendRequest(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'archon-mcp-client',
        version: '1.0.0',
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new McpConnectionError(
            server.serverName,
            `Server initialization timed out after ${INIT_TIMEOUT_MS}ms`
          )
        );
      }, INIT_TIMEOUT_MS);
    });

    await Promise.race([initPromise, timeoutPromise]);

    // Send initialized notification (no response expected)
    if (server.process?.stdin?.writable) {
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });
      const content = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`;
      server.process.stdin.write(content);
    }
  }

  private async listServerTools(server: ConnectedServer): Promise<McpToolInfo[]> {
    const result = (await sendRequest(server, 'tools/list', {})) as {
      tools?: {
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }[];
    };

    if (!result || !Array.isArray(result.tools)) {
      return [];
    }

    return result.tools.map(tool => ({
      serverName: server.serverName,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }

  private async shutdownServer(serverName: string, server: ConnectedServer): Promise<void> {
    if (!server.process) return;

    // Try graceful shutdown first
    try {
      await Promise.race([
        sendRequest(server, 'shutdown', {}),
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Ignore shutdown errors — we're going to kill the process anyway
    }

    // Kill the process
    if (server.process && !server.process.killed) {
      server.process.kill('SIGTERM');
      // If SIGTERM doesn't work, force kill after 2s
      setTimeout(() => {
        if (server.process && !server.process.killed) {
          server.process.kill('SIGKILL');
        }
      }, 2000);
    }

    log.info({ serverName }, 'mcp.server_stopped');
  }

  // -------------------------------------------------------------------------
  // Remote (SSE/HTTP) transport — uses fetch-based JSON-RPC
  // -------------------------------------------------------------------------

  private async listRemoteTools(
    serverName: string,
    config: { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }
  ): Promise<McpToolInfo[]> {
    const initResult = await this.remoteRequest(serverName, config, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'archon-mcp-client',
        version: '1.0.0',
      },
    });

    if (!initResult) {
      throw new McpConnectionError(serverName, 'Failed to initialize remote MCP session');
    }

    const result = (await this.remoteRequest(serverName, config, 'tools/list', {})) as {
      tools?: {
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }[];
    };

    if (!result || !Array.isArray(result.tools)) {
      return [];
    }

    return result.tools.map(tool => ({
      serverName,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }

  private async callRemoteTool(
    serverName: string,
    config: { type: 'sse' | 'http'; url: string; headers?: Record<string, string> },
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const result = (await this.remoteRequest(serverName, config, 'tools/call', {
      name: toolName,
      arguments: args,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean };

    return formatToolResult(result);
  }

  private async remoteRequest(
    serverName: string,
    config: { type: 'sse' | 'http'; url: string; headers?: Record<string, string> },
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers ?? {}),
        },
        body,
        signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
      });
    } catch (err) {
      const error = err as Error;
      throw new McpConnectionError(
        serverName,
        `Failed to connect to ${config.url}: ${error.message}`
      );
    }

    if (!response.ok) {
      throw new McpConnectionError(serverName, `HTTP ${response.status} from ${config.url}`);
    }

    const json = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw new McpConnectionError(
        serverName,
        `MCP server error (${json.error.code}): ${json.error.message}`
      );
    }

    return json.result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determine the transport type of an MCP server config. */
function getServerType(config: McpServerConfig): 'stdio' | 'sse' | 'http' {
  if ('type' in config && (config.type === 'sse' || config.type === 'http')) {
    return config.type;
  }
  return 'stdio';
}

/** Format an MCP tool call result into a string for the tool loop. */
function formatToolResult(
  result: { content?: { type: string; text?: string }[]; isError?: boolean } | null
): string {
  if (!result || !Array.isArray(result.content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
    }
  }

  const output = textParts.join('\n');

  if (result.isError) {
    return `[MCP Error] ${output}`;
  }

  return output;
}

/** Get a safe set of inherited environment variables. */
function getInheritedEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  const inherit = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TMP',
    'TEMP',
    'NODE_ENV',
    'BUN_INSTALL',
    'XDG_RUNTIME_DIR',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
  ];
  for (const key of inherit) {
    const val = process.env[key];
    if (val !== undefined) {
      safe[key] = val;
    }
  }
  return safe;
}
