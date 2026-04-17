import type { GridPane } from './GridEngine';
import { findFreeSlot, MAX_PANES } from './GridEngine';
import type { LaunchProfile, ProfilePane } from './LaunchProfile';
import { getProfile, toSlug } from './LaunchProfile';

// ── Types ────────────────────────────────────────────────────────

export type LaunchResult =
  | { kind: 'success'; panes: GridPane[]; warning?: string }
  | { kind: 'error'; message: string };

// ── Session naming ───────────────────────────────────────────────

/**
 * Build a deterministic tmux session name for a profile pane.
 * Format: `archon-desktop:{profileSlug}:{paneSlug}`
 */
export function buildSessionName(profileSlug: string, paneName: string): string {
  const paneSlug = toSlug(paneName);
  return `archon-desktop:${profileSlug}:${paneSlug || 'pane'}`;
}

// ── Startup command ──────────────────────────────────────────────

/**
 * Resolve a startup command string from a ProfilePane's startupAction.
 * Returns undefined if no startup action or kind is 'none'.
 *
 * Preset commands are resolved by the caller (agent presets are stored
 * externally in agents.json). This function returns the presetId so
 * the caller can look up the actual command.
 */
export function resolveStartupPresetId(
  pane: ProfilePane
): { presetId: string; modelOverride?: string } | undefined {
  if (!pane.startupAction || pane.startupAction.kind === 'none') return undefined;
  return {
    presetId: pane.startupAction.presetId,
    modelOverride: pane.startupAction.modelOverride,
  };
}

// ── Core launcher logic ──────────────────────────────────────────

/**
 * Compute which panes from a profile can be placed into the grid,
 * given the current set of existing panes.
 *
 * Returns GridPane[] for the panes that fit, plus an optional warning
 * if some panes were dropped due to the 18-slot cap.
 */
export function computeLaunchPanes(
  profile: LaunchProfile,
  existingPanes: GridPane[]
): LaunchResult {
  if (profile.panes.length === 0) {
    return { kind: 'success', panes: [] };
  }

  const totalPossible = profile.panes.length + existingPanes.length;
  const placedPanes: GridPane[] = [];
  // Track the evolving set of panes for slot allocation
  const allPanes = [...existingPanes];

  for (const profilePane of profile.panes) {
    if (allPanes.length >= MAX_PANES) break;

    const w = profilePane.w;
    const h = profilePane.h;

    const slot = findFreeSlot(allPanes, w, h);
    if (!slot) {
      // Try 1x1 as fallback
      if (w !== 1 || h !== 1) {
        const fallbackSlot = findFreeSlot(allPanes, 1, 1);
        if (fallbackSlot) {
          const pane = buildGridPane(profile, profilePane, fallbackSlot.x, fallbackSlot.y, 1, 1);
          placedPanes.push(pane);
          allPanes.push(pane);
          continue;
        }
      }
      break;
    }

    const pane = buildGridPane(profile, profilePane, slot.x, slot.y, w, h);
    placedPanes.push(pane);
    allPanes.push(pane);
  }

  let warning: string | undefined;
  if (placedPanes.length < profile.panes.length) {
    warning = `Only ${placedPanes.length} of ${profile.panes.length} panes fit — close a pane and launch again for the rest`;
  } else if (totalPossible > MAX_PANES && placedPanes.length === profile.panes.length) {
    // All profile panes fit but we're at/near capacity
    warning = undefined;
  }

  return { kind: 'success', panes: placedPanes, warning };
}

function buildGridPane(
  profile: LaunchProfile,
  profilePane: ProfilePane,
  x: number,
  y: number,
  w: number,
  h: number
): GridPane {
  return {
    id: profilePane.id,
    name: profilePane.name,
    host: profilePane.host,
    cwd: profilePane.cwd,
    sessionName: buildSessionName(profile.slug, profilePane.name),
    x,
    y,
    w,
    h,
  };
}

// ── High-level launcher ──────────────────────────────────────────

/**
 * Launch a profile by ID. Reads the profile from storage, computes
 * placement, and returns the panes to add.
 */
export function launchProfile(profileId: string, existingPanes: GridPane[]): LaunchResult {
  const profile = getProfile(profileId);
  if (!profile) {
    return { kind: 'error', message: `Profile not found: ${profileId}` };
  }
  return computeLaunchPanes(profile, existingPanes);
}
