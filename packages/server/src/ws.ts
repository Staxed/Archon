/**
 * Shared Bun WebSocket setup for Hono.
 * Creates a singleton pair of (upgradeWebSocket, websocket) that must be used together:
 * - upgradeWebSocket: Hono middleware for WS route handlers
 * - websocket: handler config passed to Bun.serve()
 */
import { createBunWebSocket } from 'hono/bun';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export { upgradeWebSocket, websocket };
