import type { GridPane } from './GridEngine';
import { findFreeSlot } from './GridEngine';

/**
 * Result of attempting to open an ad-hoc terminal.
 * Either a pane to add to the grid, or a toast message if grid is full.
 */
export type AdHocResult = { kind: 'pane'; pane: GridPane } | { kind: 'toast'; message: string };

/**
 * Creates a new ad-hoc terminal pane placed in the first free grid slot.
 * Returns a toast message if the grid is full.
 */
export function openAdHocTerminal(
  existingPanes: GridPane[],
  opts: { host: string; cwd: string }
): AdHocResult {
  const slot = findFreeSlot(existingPanes, 1, 1);
  if (!slot) {
    return { kind: 'toast', message: 'Grid full — close a pane to open another' };
  }

  const uuid = crypto.randomUUID();
  const pane: GridPane = {
    id: uuid,
    name: `adhoc-${uuid.slice(0, 8)}`,
    host: opts.host,
    cwd: opts.cwd,
    sessionName: `archon-desktop:adhoc:${uuid}`,
    x: slot.x,
    y: slot.y,
    w: 1,
    h: 1,
  };

  return { kind: 'pane', pane };
}
