/**
 * Zod schemas for desktop API endpoints.
 * All desktop routes live under /api/desktop/* and are loopback-only.
 */
import { z } from '@hono/zod-openapi';

/** GET /api/desktop/health response. */
export const desktopHealthResponseSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
  })
  .openapi('DesktopHealthResponse');

/** Query params for fs/tree endpoint. */
export const fsTreeQuerySchema = z.object({
  host: z.string(),
  root: z.string(),
});

/** A single file-tree entry. */
const fsTreeEntrySchema = z
  .object({
    name: z.string(),
    kind: z.enum(['file', 'dir']),
    size: z.number().optional(),
    mtime: z.string(),
  })
  .openapi('FsTreeEntry');

/** GET /api/desktop/fs/tree response. */
export const fsTreeResponseSchema = z
  .object({
    entries: z.array(fsTreeEntrySchema),
  })
  .openapi('FsTreeResponse');

/** Query params for fs/file GET endpoint. */
export const fsFileReadQuerySchema = z.object({
  host: z.string(),
  path: z.string(),
});

/** GET /api/desktop/fs/file response. */
export const fsFileReadResponseSchema = z
  .object({
    content: z.string(),
    encoding: z.string(),
    mtime: z.string(),
    size: z.number(),
  })
  .openapi('FsFileReadResponse');

/** PUT /api/desktop/fs/file request body. */
export const fsFileWriteBodySchema = z
  .object({
    content: z.string(),
    expectedMtime: z.string().optional(),
  })
  .openapi('FsFileWriteBody');

/** Query params for tmux/list endpoint. */
export const tmuxListQuerySchema = z.object({
  host: z.string(),
});

/** A single tmux session entry. */
const tmuxSessionSchema = z
  .object({
    name: z.string(),
    createdAt: z.string(),
    cwd: z.string(),
    status: z.string(),
  })
  .openapi('TmuxSession');

/** GET /api/desktop/tmux/list response. */
export const tmuxListResponseSchema = z
  .object({
    sessions: z.array(tmuxSessionSchema),
  })
  .openapi('TmuxListResponse');

/** POST /api/desktop/tmux/kill query params. */
export const tmuxKillQuerySchema = z.object({
  host: z.string(),
  sessionName: z.string(),
});

/** 501 Not Implemented response. */
export const notImplementedResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi('DesktopNotImplemented');

/** 403 Forbidden response for loopback guard. */
export const loopbackForbiddenResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi('DesktopLoopbackForbidden');

/** A single preflight dependency check result. */
const preflightCheckSchema = z
  .object({
    name: z.string(),
    present: z.boolean(),
    version: z.string().optional(),
    installCommand: z.string().optional(),
    warning: z.string().optional(),
  })
  .openapi('PreflightCheck');

/** GET /api/desktop/preflight response. */
export const preflightResponseSchema = z
  .object({
    checks: z.array(preflightCheckSchema),
  })
  .openapi('PreflightResponse');
