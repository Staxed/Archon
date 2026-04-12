/**
 * Provider schema — shared across workflow and dag-node schemas.
 * Extracted to its own file to avoid circular imports between workflow.ts and dag-node.ts.
 */
import { z } from '@hono/zod-openapi';

export const providerSchema = z.enum(['claude', 'codex', 'openrouter', 'llamacpp']);

export type ProviderType = z.infer<typeof providerSchema>;
