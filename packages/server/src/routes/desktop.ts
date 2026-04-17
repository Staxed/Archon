/**
 * Desktop API routes — loopback-only endpoints for the Archon Desktop app.
 * All routes live under /api/desktop/* and reject non-loopback requests with 403.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { readFileSync } from 'fs';
import {
  access,
  mkdir,
  readdir,
  readFile as fsReadFile,
  rename,
  stat,
  writeFile,
} from 'fs/promises';
import { dirname, join, normalize, resolve } from 'path';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import { upgradeWebSocket } from '../ws';
import {
  desktopHealthResponseSchema,
  fsTreeQuerySchema,
  fsTreeResponseSchema,
  fsFileReadQuerySchema,
  fsFileReadResponseSchema,
  fsFileWriteQuerySchema,
  fsFileWriteBodySchema,
  fsFileWriteResponseSchema,
  conflictResponseSchema,
  tooLargeResponseSchema,
  tmuxListQuerySchema,
  tmuxListResponseSchema,
  tmuxKillQuerySchema,
  tmuxRenameQuerySchema,
  notFoundResponseSchema,
  loopbackForbiddenResponseSchema,
  preflightResponseSchema,
  aichatEnsureConfigResponseSchema,
} from './schemas/desktop.schemas';

const execFileAsync = promisify(execFile);

// Read app version once at module load
let appVersion = 'unknown';
try {
  const pkgContent = readFileSync(join(import.meta.dir, '../../../../package.json'), 'utf-8');
  const pkg = JSON.parse(pkgContent) as { version?: string };
  appVersion = pkg.version ?? 'unknown';
} catch {
  // package.json not found (binary build or unusual install)
}

/**
 * Extract the remote IP address from a Hono context.
 * In Bun, `c.env` contains `{ incoming, server }` where server.requestIP()
 * returns the client IP. Falls back to header-based detection for proxied setups.
 */
export function getRemoteAddress(c: Context): string {
  try {
    const env = c.env as {
      incoming?: Request;
      server?: { requestIP?: (req: Request) => { address: string } | null };
    };
    if (env.server?.requestIP && env.incoming) {
      const ip = env.server.requestIP(env.incoming);
      if (ip) return ip.address;
    }
  } catch {
    // Fall through to unknown
  }
  return 'unknown';
}

/**
 * Check whether an IP address is a loopback address.
 */
export function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// =========================================================================
// Preflight dependency checks
// =========================================================================

interface PreflightCheck {
  name: string;
  present: boolean;
  version?: string;
  installCommand?: string;
  warning?: string;
}

/**
 * Run a command and return its stdout, or null if it fails.
 */
export async function checkCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string } | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
    return { stdout: stdout.trim() };
  } catch {
    return null;
  }
}

/**
 * Parse version string from tmux -V output (e.g. "tmux 3.4" → "3.4").
 */
function parseTmuxVersion(output: string): string | undefined {
  const match = /tmux\s+(\d+\.\d+[a-z]?)/.exec(output);
  return match?.[1];
}

/**
 * Check if tmux version is less than 3.0 (needs -A flag support).
 */
function isTmuxVersionLow(version: string): boolean {
  const major = parseInt(version.split('.')[0], 10);
  return major < 3;
}

/**
 * Run all preflight dependency checks on the local (server) host.
 */
export async function runPreflightChecks(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  // tmux
  const tmux = await checkCommand('tmux', ['-V']);
  const tmuxVersion = tmux ? parseTmuxVersion(tmux.stdout) : undefined;
  const tmuxCheck: PreflightCheck = {
    name: 'tmux',
    present: tmux !== null,
    version: tmuxVersion,
    installCommand: 'sudo apt install tmux',
  };
  if (tmux && tmuxVersion && isTmuxVersionLow(tmuxVersion)) {
    tmuxCheck.warning = `tmux ${tmuxVersion} is below 3.0 — the -A flag (attach-or-create) requires tmux 3.0+`;
  }
  checks.push(tmuxCheck);

  // aichat
  const aichat = await checkCommand('aichat', ['--version']);
  checks.push({
    name: 'aichat',
    present: aichat !== null,
    version: aichat?.stdout.replace(/^aichat\s+/i, ''),
    installCommand: 'cargo install aichat',
  });

  // typescript-language-server
  const tsls = await checkCommand('typescript-language-server', ['--version']);
  checks.push({
    name: 'typescript-language-server',
    present: tsls !== null,
    version: tsls?.stdout,
    installCommand: 'npm i -g typescript-language-server typescript',
  });

  // Archon (check via own health endpoint — just use the module-scoped version)
  checks.push({
    name: 'archon',
    present: appVersion !== 'unknown',
    version: appVersion !== 'unknown' ? appVersion : undefined,
  });

  return checks;
}

// =========================================================================
// File-system helpers
// =========================================================================

interface FsTreeEntry {
  name: string;
  kind: 'file' | 'dir';
  size?: number;
  mtime: string;
}

/**
 * Validate that a resolved path is still within the allowed root.
 * Rejects `..` traversal attempts that escape the root directory.
 */
export function isPathWithinRoot(requestedPath: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(normalize(requestedPath));
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + '/');
}

/**
 * Check if a path contains `..` traversal components.
 * Checks the raw path segments before normalization to catch traversal attempts.
 */
export function containsTraversal(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.includes('..');
}

/**
 * List immediate children of a directory path.
 * Returns entries sorted by name with kind, size (files only), and mtime.
 */
export async function listDirectory(dirPath: string): Promise<FsTreeEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const results: FsTreeEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const kind = entry.isDirectory() ? 'dir' : 'file';
    try {
      const stats = await stat(fullPath);
      results.push({
        name: entry.name,
        kind,
        size: kind === 'file' ? stats.size : undefined,
        mtime: stats.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (broken symlinks, permission issues on individual files)
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Maximum file size for read (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Read a file and return its content, encoding, mtime, and size.
 * Throws if the file is larger than MAX_FILE_SIZE.
 */
export async function readFileContent(
  filePath: string
): Promise<{ content: string; encoding: string; mtime: string; size: number }> {
  const stats = await stat(filePath);

  if (stats.size > MAX_FILE_SIZE) {
    const err = new Error('File too large') as Error & { code: string; size: number };
    err.code = 'TOO_LARGE';
    err.size = stats.size;
    throw err;
  }

  const content = await fsReadFile(filePath, 'utf-8');
  return {
    content,
    encoding: 'utf-8',
    mtime: stats.mtime.toISOString(),
    size: stats.size,
  };
}

/**
 * Write a file atomically using tempfile + rename.
 * If expectedMtime is provided and the file's current mtime differs, returns conflict info.
 * If createParents is true, creates parent directories as needed.
 */
export async function writeFileAtomically(
  filePath: string,
  content: string,
  options: { expectedMtime?: string; createParents?: boolean }
): Promise<
  { ok: true; mtime: string } | { conflict: true; currentContent: string; currentMtime: string }
> {
  // Check for mtime conflict if expectedMtime is provided
  if (options.expectedMtime) {
    try {
      const currentStats = await stat(filePath);
      const currentMtime = currentStats.mtime.toISOString();
      if (currentMtime !== options.expectedMtime) {
        const currentContent = await fsReadFile(filePath, 'utf-8');
        return { conflict: true, currentContent, currentMtime };
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      // File doesn't exist yet — no conflict possible, proceed with write
      if (error.code !== 'ENOENT') throw err;
    }
  }

  const dir = dirname(filePath);

  // Create parent directories if requested
  if (options.createParents) {
    await mkdir(dir, { recursive: true });
  }

  // Write to a tempfile in the same directory, then rename (atomic on same filesystem)
  const tmpPath = filePath + `.tmp.${Date.now()}`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);

  // Return the new mtime
  const newStats = await stat(filePath);
  return { ok: true, mtime: newStats.mtime.toISOString() };
}

// =========================================================================
// aichat config helpers
// =========================================================================

/**
 * Default path for aichat config file.
 */
export function getAichatConfigPath(): string {
  return join(homedir(), '.config', 'aichat', 'config.yaml');
}

/**
 * Check if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the aichat config YAML content.
 * Configures OpenRouter and Llama.cpp clients for aichat.
 */
export function buildAichatConfig(openrouterApiKey: string | undefined): string {
  const lines: string[] = [];
  lines.push('# Auto-generated by Archon Desktop');
  lines.push('# OpenRouter + Llama.cpp configuration for aichat');
  lines.push('');

  if (openrouterApiKey) {
    lines.push('clients:');
    lines.push('  - type: openai-compatible');
    lines.push('    name: openrouter');
    lines.push('    api_base: https://openrouter.ai/api/v1');
    lines.push(`    api_key: ${openrouterApiKey}`);
    lines.push('    models:');
    lines.push('      - name: anthropic/claude-sonnet-4');
    lines.push('        max_input_tokens: 200000');
    lines.push('      - name: anthropic/claude-haiku-4');
    lines.push('        max_input_tokens: 200000');
    lines.push('      - name: meta-llama/llama-4-scout');
    lines.push('        max_input_tokens: 131072');
    lines.push('');
    lines.push('  - type: openai-compatible');
    lines.push('    name: llamacpp');
    lines.push('    api_base: http://localhost:8093/v1');
    lines.push('    api_key: null');
    lines.push('    models:');
    lines.push('      - name: local');
    lines.push('        max_input_tokens: 131072');
  } else {
    lines.push('clients:');
    lines.push('  - type: openai-compatible');
    lines.push('    name: llamacpp');
    lines.push('    api_base: http://localhost:8093/v1');
    lines.push('    api_key: null');
    lines.push('    models:');
    lines.push('      - name: local');
    lines.push('        max_input_tokens: 131072');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Ensure aichat config exists on the server host.
 * Returns { created, validated, message }.
 */
export async function ensureAichatConfig(): Promise<{
  created: boolean;
  validated: boolean;
  message: string;
}> {
  const configPath = getAichatConfigPath();

  // Check if config already exists — never overwrite
  if (await fileExists(configPath)) {
    return { created: false, validated: true, message: 'Config already exists — not modified' };
  }

  // Read OpenRouter API key from environment (same source as @archon/core openrouter client)
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;

  // Build and write config
  const configContent = buildAichatConfig(openrouterApiKey);
  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, configContent, 'utf-8');

  // Validate by running aichat --list-models
  const validation = await checkCommand('aichat', ['--list-models']);
  const validated = validation !== null;

  const message = validated
    ? 'Config created and validated successfully'
    : 'Config created but validation failed — aichat --list-models returned an error';

  return { created: true, validated, message };
}

// =========================================================================
// Route definitions (module-scope — pure config, no runtime dependencies)
// =========================================================================

const desktopHealthRoute = createRoute({
  method: 'get',
  path: '/api/desktop/health',
  tags: ['Desktop'],
  summary: 'Desktop health check',
  responses: {
    200: {
      content: { 'application/json': { schema: desktopHealthResponseSchema } },
      description: 'Health status',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — non-loopback request',
    },
  },
});

const preflightRoute = createRoute({
  method: 'get',
  path: '/api/desktop/preflight',
  tags: ['Desktop'],
  summary: 'Check remote host dependencies (tmux, aichat, language servers, archon)',
  responses: {
    200: {
      content: { 'application/json': { schema: preflightResponseSchema } },
      description: 'Preflight check results',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — non-loopback request',
    },
  },
});

const fsTreeRoute = createRoute({
  method: 'get',
  path: '/api/desktop/fs/tree',
  tags: ['Desktop'],
  summary: 'List immediate children of a remote path',
  request: { query: fsTreeQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: fsTreeResponseSchema } },
      description: 'Directory listing',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — non-loopback or path traversal',
    },
    404: {
      content: { 'application/json': { schema: notFoundResponseSchema } },
      description: 'Path does not exist',
    },
  },
});

const fsFileReadRoute = createRoute({
  method: 'get',
  path: '/api/desktop/fs/file',
  tags: ['Desktop'],
  summary: 'Read a remote file',
  request: { query: fsFileReadQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: fsFileReadResponseSchema } },
      description: 'File contents',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — path traversal or loopback violation',
    },
    404: {
      content: { 'application/json': { schema: notFoundResponseSchema } },
      description: 'File not found',
    },
    413: {
      content: { 'application/json': { schema: tooLargeResponseSchema } },
      description: 'File exceeds 10 MB limit',
    },
  },
});

const fsFileWriteRoute = createRoute({
  method: 'put',
  path: '/api/desktop/fs/file',
  tags: ['Desktop'],
  summary: 'Write a remote file atomically',
  request: {
    query: fsFileWriteQuerySchema,
    body: { content: { 'application/json': { schema: fsFileWriteBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: fsFileWriteResponseSchema } },
      description: 'File written',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — path traversal or loopback violation',
    },
    409: {
      content: { 'application/json': { schema: conflictResponseSchema } },
      description: 'Conflict — file changed on disk since last read',
    },
  },
});

const tmuxListRoute = createRoute({
  method: 'get',
  path: '/api/desktop/tmux/list',
  tags: ['Desktop'],
  summary: 'List tmux sessions on a remote host',
  request: { query: tmuxListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: tmuxListResponseSchema } },
      description: 'Session listing',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
  },
});

const tmuxKillRoute = createRoute({
  method: 'post',
  path: '/api/desktop/tmux/kill',
  tags: ['Desktop'],
  summary: 'Kill a tmux session on a remote host',
  request: { query: tmuxKillQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }).openapi('TmuxKillResponse') },
      },
      description: 'Session killed',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
    404: {
      content: { 'application/json': { schema: notFoundResponseSchema } },
      description: 'Session not found',
    },
  },
});

const tmuxRenameRoute = createRoute({
  method: 'post',
  path: '/api/desktop/tmux/rename',
  tags: ['Desktop'],
  summary: 'Rename a tmux session on a remote host',
  request: { query: tmuxRenameQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean() }).openapi('TmuxRenameResponse'),
        },
      },
      description: 'Session renamed',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
    404: {
      content: { 'application/json': { schema: notFoundResponseSchema } },
      description: 'Session not found',
    },
  },
});

const aichatEnsureConfigRoute = createRoute({
  method: 'post',
  path: '/api/desktop/aichat/ensure-config',
  tags: ['Desktop'],
  summary: 'Ensure aichat config exists on the remote host',
  responses: {
    200: {
      content: { 'application/json': { schema: aichatEnsureConfigResponseSchema } },
      description: 'Config status',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden — non-loopback request',
    },
    500: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }).openapi('AichatEnsureConfigError'),
        },
      },
      description: 'Config creation failed',
    },
  },
});

// =========================================================================
// PTY WebSocket helpers
// =========================================================================

/** Session name regex — prevents shell injection in tmux commands. */
const SESSION_NAME_REGEX = /^archon-desktop:[a-z0-9:-]+$/;

/** Validate a tmux session name against the allowed pattern. */
export function validateSessionName(name: string): boolean {
  return SESSION_NAME_REGEX.test(name);
}

/** Build args for `tmux new-session -A -d -s <name> [-c <cwd>] [<command>]`. */
export function buildTmuxNewSessionArgs(
  sessionName: string,
  cwd?: string,
  command?: string
): string[] {
  const args = ['new-session', '-A', '-d', '-s', sessionName];
  if (cwd) args.push('-c', cwd);
  if (command) args.push(command);
  return args;
}

/** Build the shell command string for `script -qfc` to attach to a tmux session. */
export function buildTmuxAttachCommand(sessionName: string): string {
  return `tmux attach-session -t ${sessionName}`;
}

/** Build args for `tmux resize-window -t <name> -x <cols> -y <rows>`. */
export function buildTmuxResizeArgs(sessionName: string, cols: number, rows: number): string[] {
  return ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)];
}

/** Build args for `tmux list-sessions -F <format>`. */
export function buildTmuxListSessionsArgs(): string[] {
  return [
    'list-sessions',
    '-F',
    '#{session_name}|#{session_created}|#{session_path}|#{?session_attached,attached,detached}',
  ];
}

/** Build args for `tmux kill-session -t <name>`. */
export function buildTmuxKillSessionArgs(sessionName: string): string[] {
  return ['kill-session', '-t', sessionName];
}

/** Build args for `tmux rename-session -t <from> <to>`. */
export function buildTmuxRenameSessionArgs(from: string, to: string): string[] {
  return ['rename-session', '-t', from, to];
}

/** A parsed tmux session entry. */
interface TmuxSessionEntry {
  name: string;
  createdAt: string;
  cwd: string;
  status: string;
}

/**
 * Parse tmux list-sessions output (pipe-delimited format).
 * Each line: `name|created_epoch|path|attached/detached`
 */
export function parseTmuxListSessions(output: string): TmuxSessionEntry[] {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const [name, createdEpoch, cwd, status] = line.split('|');
    const epoch = parseInt(createdEpoch, 10);
    const createdAt = isNaN(epoch) ? createdEpoch : new Date(epoch * 1000).toISOString();
    return {
      name: name ?? '',
      createdAt,
      cwd: cwd ?? '',
      status: status ?? 'unknown',
    };
  });
}

/**
 * Spawn a child process. Exported for testability (allows spyOn in tests).
 */
export function spawnProcess(
  command: string,
  args: string[],
  options: { stdio: 'ignore' | ('pipe' | 'ignore')[] }
): ChildProcess {
  return spawn(command, args, options);
}

// =========================================================================
// LSP proxy helpers
// =========================================================================

/**
 * Supported language → language server command + args.
 * Returns null if the language is not supported.
 */
export function getLanguageServerCommand(
  language: string
): { command: string; args: string[] } | null {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return { command: 'typescript-language-server', args: ['--stdio'] };
    case 'python':
      return { command: 'pylsp', args: [] };
    case 'go':
      return { command: 'gopls', args: ['serve'] };
    case 'rust':
      return { command: 'rust-analyzer', args: [] };
    case 'markdown':
      return { command: 'marksman', args: ['server'] };
    default:
      return null;
  }
}

/**
 * Build a unique key for an LSP connection (language + project dir).
 * Reuse connections for files within the same project dir and language.
 */
export function lspConnectionKey(language: string, projectDir: string): string {
  return `${language}:${projectDir}`;
}

/**
 * Active LSP server processes keyed by lspConnectionKey.
 * Allows reuse of an existing language server for subsequent files in the same project.
 */
const activeLspServers = new Map<string, { process: ChildProcess; refCount: number }>();

/**
 * Get or spawn a language server process for the given language and project dir.
 * Increments refCount when reusing; callers must call releaseLspServer when done.
 */
export function acquireLspServer(
  language: string,
  projectDir: string
): { process: ChildProcess; key: string; reused: boolean } | null {
  const cmd = getLanguageServerCommand(language);
  if (!cmd) return null;

  const key = lspConnectionKey(language, projectDir);
  const existing = activeLspServers.get(key);
  if (existing && !existing.process.killed) {
    existing.refCount++;
    return { process: existing.process, key, reused: true };
  }

  // Spawn a new language server
  const proc = spawnProcess(cmd.command, cmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.on('exit', () => {
    activeLspServers.delete(key);
  });
  activeLspServers.set(key, { process: proc, refCount: 1 });
  return { process: proc, key, reused: false };
}

/**
 * Release a reference to an LSP server. When refCount reaches 0, the server is killed.
 */
export function releaseLspServer(key: string): void {
  const entry = activeLspServers.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.process.kill();
    activeLspServers.delete(key);
  }
}

// =========================================================================
// Route registration
// =========================================================================

/**
 * Register all /api/desktop/* routes on the Hono app.
 * Applies a loopback-only middleware that rejects non-127.0.0.1/::1 requests with 403.
 */
export function setupDesktopRoutes(app: OpenAPIHono): void {
  // Loopback guard middleware — applied to all /api/desktop/* routes
  app.use('/api/desktop/*', async (c, next) => {
    const address = getRemoteAddress(c);
    if (!isLoopback(address)) {
      c.res = c.json({ error: 'Forbidden — desktop endpoints are loopback-only' }, 403);
      return;
    }
    await next();
  });

  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  // GET /api/desktop/health — returns 200 with ok + version
  registerOpenApiRoute(desktopHealthRoute, c => {
    return c.json({ ok: true, version: appVersion });
  });

  // GET /api/desktop/preflight — check remote host dependencies
  registerOpenApiRoute(preflightRoute, async c => {
    const checks = await runPreflightChecks();
    return c.json({ checks });
  });

  // GET /api/desktop/fs/tree — list immediate children of a directory
  registerOpenApiRoute(fsTreeRoute, async c => {
    const { root } = c.req.query();

    // Reject paths containing '..' to prevent traversal attacks
    if (containsTraversal(root)) {
      return c.json({ error: 'Forbidden — path traversal detected' }, 403);
    }

    const resolvedRoot = resolve(normalize(root));

    try {
      const entries = await listDirectory(resolvedRoot);
      return c.json({ entries });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return c.json({ error: `Path not found: ${root}` }, 404);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return c.json({ error: `Permission denied: ${root}` }, 403);
      }
      return c.json({ error: `Failed to list directory: ${error.message}` }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/desktop/fs/file — read a file
  // -----------------------------------------------------------------------
  registerOpenApiRoute(fsFileReadRoute, async c => {
    const { path: filePath } = c.req.query();

    if (containsTraversal(filePath)) {
      return c.json({ error: 'Forbidden — path traversal detected' }, 403);
    }

    const resolvedPath = resolve(normalize(filePath));

    try {
      const result = await readFileContent(resolvedPath);
      return c.json(result);
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { size?: number };
      if (error.code === 'TOO_LARGE') {
        return c.json(
          { error: 'File exceeds 10 MB limit', size: error.size ?? 0, maxSize: MAX_FILE_SIZE },
          413
        );
      }
      if (error.code === 'ENOENT') {
        return c.json({ error: `File not found: ${filePath}` }, 404);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return c.json({ error: `Permission denied: ${filePath}` }, 403);
      }
      return c.json({ error: `Failed to read file: ${error.message}` }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/desktop/fs/file — write a file atomically
  // -----------------------------------------------------------------------
  registerOpenApiRoute(fsFileWriteRoute, async c => {
    const { path: filePath, createParents } = c.req.query();

    if (containsTraversal(filePath)) {
      return c.json({ error: 'Forbidden — path traversal detected' }, 403);
    }

    const resolvedPath = resolve(normalize(filePath));
    const body = await c.req.json();
    const { content, expectedMtime } = body as { content: string; expectedMtime?: string };

    try {
      const result = await writeFileAtomically(resolvedPath, content, {
        expectedMtime,
        createParents: createParents === 'true',
      });

      if ('conflict' in result) {
        return c.json(
          {
            error: 'File changed on disk since last read',
            currentContent: result.currentContent,
            currentMtime: result.currentMtime,
          },
          409
        );
      }

      return c.json({ ok: true, mtime: result.mtime });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return c.json(
          {
            error: `Parent directory does not exist: ${filePath}. Use createParents=true to create it.`,
          },
          404
        );
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return c.json({ error: `Permission denied: ${filePath}` }, 403);
      }
      return c.json({ error: `Failed to write file: ${error.message}` }, 500);
    }
  });

  // WS /api/desktop/lsp — LSP proxy endpoint (language server relay)
  // No OpenAPI route — WS upgrade is not spec'd, same pattern as PTY.
  // Loopback guard middleware at /api/desktop/* still applies.

  // -----------------------------------------------------------------------
  // POST /api/desktop/aichat/ensure-config — ensure aichat config exists
  // -----------------------------------------------------------------------
  registerOpenApiRoute(aichatEnsureConfigRoute, async c => {
    try {
      const result = await ensureAichatConfig();
      return c.json(result);
    } catch (err) {
      const error = err as Error;
      return c.json({ error: `Failed to ensure aichat config: ${error.message}` }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/desktop/tmux/list — list tmux sessions on the server host
  // -----------------------------------------------------------------------
  registerOpenApiRoute(tmuxListRoute, async c => {
    try {
      const { stdout } = await execFileAsync('tmux', buildTmuxListSessionsArgs(), {
        timeout: 10_000,
      });
      const sessions = parseTmuxListSessions(stdout);
      return c.json({ sessions });
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { stderr?: string };
      // tmux returns exit code 1 with "no server running" or "no sessions" when there are none
      if (error.stderr?.includes('no server running') || error.stderr?.includes('no sessions')) {
        return c.json({ sessions: [] });
      }
      return c.json({ sessions: [] });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/desktop/tmux/kill — kill a tmux session by name
  // -----------------------------------------------------------------------
  registerOpenApiRoute(tmuxKillRoute, async c => {
    const { sessionName } = c.req.query();

    if (!validateSessionName(sessionName)) {
      return c.json({ error: 'Invalid session name — must match archon-desktop:[a-z0-9:-]+' }, 403);
    }

    try {
      await execFileAsync('tmux', buildTmuxKillSessionArgs(sessionName), { timeout: 10_000 });
      return c.json({ ok: true });
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { stderr?: string };
      if (
        error.stderr?.includes('session not found') ||
        error.stderr?.includes("can't find session")
      ) {
        return c.json({ error: `Session not found: ${sessionName}` }, 404);
      }
      return c.json({ error: `Failed to kill session: ${error.message}` }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/desktop/tmux/rename — rename a tmux session
  // -----------------------------------------------------------------------
  registerOpenApiRoute(tmuxRenameRoute, async c => {
    const { from, to } = c.req.query();

    if (!validateSessionName(from)) {
      return c.json(
        { error: 'Invalid source session name — must match archon-desktop:[a-z0-9:-]+' },
        403
      );
    }
    if (!validateSessionName(to)) {
      return c.json(
        { error: 'Invalid target session name — must match archon-desktop:[a-z0-9:-]+' },
        403
      );
    }

    try {
      await execFileAsync('tmux', buildTmuxRenameSessionArgs(from, to), { timeout: 10_000 });
      return c.json({ ok: true });
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { stderr?: string };
      if (
        error.stderr?.includes('session not found') ||
        error.stderr?.includes("can't find session")
      ) {
        return c.json({ error: `Session not found: ${from}` }, 404);
      }
      return c.json({ error: `Failed to rename session: ${error.message}` }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // WS /api/desktop/pty — WebSocket PTY endpoint (tmux-backed remote shells)
  // -----------------------------------------------------------------------
  // Registered as a plain Hono route (not OpenAPI — WS upgrade is not spec'd).
  // Loopback guard middleware at /api/desktop/* still applies.
  app.get(
    '/api/desktop/pty',
    upgradeWebSocket(c => {
      const url = new URL(c.req.url);
      const sessionName = url.searchParams.get('sessionName') ?? '';
      const cwd = url.searchParams.get('cwd') ?? undefined;
      const command = url.searchParams.get('command') ?? undefined;

      let attachProcess: ChildProcess | null = null;

      return {
        onOpen(_event, ws): void {
          // Validate session name to prevent shell injection
          if (!validateSessionName(sessionName)) {
            ws.close(1008, 'Invalid session name — must match archon-desktop:[a-z0-9:-]+');
            return;
          }

          // Step 1: Ensure tmux session exists (create-or-attach, detached)
          const newSessionArgs = buildTmuxNewSessionArgs(sessionName, cwd, command);
          const createProc = spawnProcess('tmux', newSessionArgs, { stdio: 'ignore' });

          createProc.on('close', () => {
            // Step 2: Attach to the session via a PTY wrapper (script provides PTY)
            // Using Linux `script -qfc` to allocate a pseudo-terminal for tmux attach
            const attachCmd = buildTmuxAttachCommand(sessionName);
            attachProcess = spawnProcess('script', ['-qfc', attachCmd, '/dev/null'], {
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            // Bridge stdout → WS (binary-safe byte relay)
            attachProcess.stdout?.on('data', (data: Buffer) => {
              try {
                // Copy to a fresh ArrayBuffer to satisfy WS send type constraints
                const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                ws.send(bytes as ArrayBuffer);
              } catch {
                // WS already closed
              }
            });

            // Bridge stderr → WS (for tmux diagnostic output)
            attachProcess.stderr?.on('data', (data: Buffer) => {
              try {
                const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                ws.send(bytes as ArrayBuffer);
              } catch {
                // WS already closed
              }
            });

            // If the attach process exits, close the WS
            attachProcess.on('close', () => {
              attachProcess = null;
              try {
                ws.close(1000, 'Process exited');
              } catch {
                // WS already closed
              }
            });
          });
        },

        onMessage(event): void {
          if (!attachProcess?.stdin) return;

          const data = event.data;

          // Try to parse as JSON resize message: { type: 'resize', cols, rows }
          if (typeof data === 'string') {
            try {
              const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
              if (
                msg.type === 'resize' &&
                typeof msg.cols === 'number' &&
                typeof msg.rows === 'number'
              ) {
                // Resize the tmux window (fire-and-forget)
                spawnProcess('tmux', buildTmuxResizeArgs(sessionName, msg.cols, msg.rows), {
                  stdio: 'ignore',
                });
                return;
              }
            } catch {
              // Not JSON — treat as terminal input
            }
            attachProcess.stdin.write(data);
          } else if (data instanceof ArrayBuffer) {
            attachProcess.stdin.write(Buffer.from(data));
          }
        },

        onClose(): void {
          // Kill the attach process — this detaches from tmux, session keeps running
          if (attachProcess) {
            attachProcess.kill();
            attachProcess = null;
          }
        },

        onError(): void {
          if (attachProcess) {
            attachProcess.kill();
            attachProcess = null;
          }
        },
      };
    })
  );

  // -----------------------------------------------------------------------
  // WS /api/desktop/lsp — LSP proxy endpoint (language server relay)
  // -----------------------------------------------------------------------
  // Spawns the appropriate language server on the server host and relays
  // JSON-RPC messages bidirectionally between the WebSocket and the LS process.
  // On-demand spawn per project dir; reuse connection for subsequent files.
  app.get(
    '/api/desktop/lsp',
    upgradeWebSocket(c => {
      const url = new URL(c.req.url);
      const language = url.searchParams.get('language') ?? '';
      const projectDir = url.searchParams.get('projectDir') ?? '';

      let lspKey: string | null = null;
      let lspProc: ChildProcess | null = null;

      return {
        onOpen(_event, ws): void {
          if (!language || !projectDir) {
            ws.close(1008, 'Missing required query params: language, projectDir');
            return;
          }

          const cmd = getLanguageServerCommand(language);
          if (!cmd) {
            ws.close(
              1008,
              `Unsupported language: ${language}. Supported: typescript, javascript, python, go, rust, markdown`
            );
            return;
          }

          const acquired = acquireLspServer(language, projectDir);
          if (!acquired) {
            ws.close(1011, `Failed to start language server for ${language}`);
            return;
          }

          lspKey = acquired.key;
          lspProc = acquired.process;

          // Relay stdout (JSON-RPC responses) → WebSocket
          // LSP uses Content-Length headers followed by JSON-RPC body.
          // We relay raw bytes — the client LSP library handles framing.
          lspProc.stdout?.on('data', (data: Buffer) => {
            try {
              ws.send(data.toString('utf-8'));
            } catch {
              // WS already closed
            }
          });

          // Relay stderr → WebSocket as diagnostic messages (prefixed)
          lspProc.stderr?.on('data', (data: Buffer) => {
            try {
              ws.send(
                JSON.stringify({
                  type: 'lsp-stderr',
                  message: data.toString('utf-8'),
                })
              );
            } catch {
              // WS already closed
            }
          });

          // If the LS process exits, close the WS
          lspProc.on('close', () => {
            lspProc = null;
            try {
              ws.close(1000, 'Language server exited');
            } catch {
              // WS already closed
            }
          });
        },

        onMessage(event): void {
          if (!lspProc?.stdin) return;

          // Forward JSON-RPC messages from the client to the LS process.
          const data = event.data;
          if (typeof data === 'string') {
            lspProc.stdin.write(data);
          } else if (data instanceof ArrayBuffer) {
            lspProc.stdin.write(Buffer.from(data));
          }
        },

        onClose(): void {
          if (lspKey) {
            releaseLspServer(lspKey);
            lspKey = null;
            lspProc = null;
          }
        },

        onError(): void {
          if (lspKey) {
            releaseLspServer(lspKey);
            lspKey = null;
            lspProc = null;
          }
        },
      };
    })
  );
}
