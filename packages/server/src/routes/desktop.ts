/**
 * Desktop API routes — loopback-only endpoints for the Archon Desktop app.
 * All routes live under /api/desktop/* and reject non-loopback requests with 403.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  desktopHealthResponseSchema,
  fsTreeQuerySchema,
  fsTreeResponseSchema,
  fsFileReadQuerySchema,
  fsFileReadResponseSchema,
  fsFileWriteBodySchema,
  tmuxListQuerySchema,
  tmuxListResponseSchema,
  tmuxKillQuerySchema,
  notImplementedResponseSchema,
  loopbackForbiddenResponseSchema,
  preflightResponseSchema,
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
// Route definitions (module-scope — pure config, no runtime dependencies)
// =========================================================================

function json501(description: string): {
  content: { 'application/json': { schema: typeof notImplementedResponseSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: notImplementedResponseSchema } }, description };
}

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
      description: 'Forbidden',
    },
    501: json501('Not implemented'),
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
      description: 'Forbidden',
    },
    501: json501('Not implemented'),
  },
});

const fsFileWriteRoute = createRoute({
  method: 'put',
  path: '/api/desktop/fs/file',
  tags: ['Desktop'],
  summary: 'Write a remote file atomically',
  request: {
    query: fsFileReadQuerySchema,
    body: { content: { 'application/json': { schema: fsFileWriteBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean() }).openapi('FsFileWriteResponse'),
        },
      },
      description: 'File written',
    },
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
    501: json501('Not implemented'),
  },
});

const ptyRoute = createRoute({
  method: 'get',
  path: '/api/desktop/pty',
  tags: ['Desktop'],
  summary: 'WebSocket PTY endpoint (placeholder)',
  responses: {
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
    501: json501('Not implemented — future WebSocket endpoint'),
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
    501: json501('Not implemented'),
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
    501: json501('Not implemented'),
  },
});

const lspRoute = createRoute({
  method: 'get',
  path: '/api/desktop/lsp',
  tags: ['Desktop'],
  summary: 'WebSocket LSP proxy endpoint (placeholder)',
  responses: {
    403: {
      content: { 'application/json': { schema: loopbackForbiddenResponseSchema } },
      description: 'Forbidden',
    },
    501: json501('Not implemented — future WebSocket endpoint'),
  },
});

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

  // Placeholder 501 handlers
  const notImplemented = (c: Context): Response => c.json({ error: 'Not implemented' }, 501);

  registerOpenApiRoute(fsTreeRoute, notImplemented);
  registerOpenApiRoute(fsFileReadRoute, notImplemented);
  registerOpenApiRoute(fsFileWriteRoute, notImplemented);
  registerOpenApiRoute(ptyRoute, notImplemented);
  registerOpenApiRoute(tmuxListRoute, notImplemented);
  registerOpenApiRoute(tmuxKillRoute, notImplemented);
  registerOpenApiRoute(lspRoute, notImplemented);
}
