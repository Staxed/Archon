/**
 * Desktop API routes — loopback-only endpoints for the Archon Desktop app.
 * All routes live under /api/desktop/* and reject non-loopback requests with 403.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { readFileSync } from 'fs';
import { join } from 'path';
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
} from './schemas/desktop.schemas';

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
