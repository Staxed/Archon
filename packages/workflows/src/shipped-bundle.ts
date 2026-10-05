/**
 * Is this run's workflow Archon's shipped bundled one, byte for byte?
 *
 * Stixed's Jev guard (the archon channel) reads `workflow_source: "bundled"` as "this
 * workflow says what the shipped default says" and lets the workflow's declared intent
 * (push a branch, open a PR, ...) release the actions it lists. Discovery's `source`
 * label cannot carry that: a repo file with a bundled workflow's filename keeps the
 * `bundled` label (the repo's `defaults/` re-discovers them), and a source build reads
 * its bundled defaults from files on disk. So the guard's label is decided here, by
 * content: a workflow file counts only when its bytes hash to the shipped bundle's copy
 * of the same name (BUNDLED_WORKFLOWS, generated from the files Archon ships), and a
 * workflow only when it and every workflow it `include:`s count, and every command file
 * those workflows' nodes name resolves (in the run's own lookup order: repo command
 * folders, then `~/.archon/commands/`, then the bundled defaults) to bytes identical to
 * the shipped bundle's copy (BUNDLED_COMMANDS). A project or home override of one of
 * those commands leaves the YAML untouched but runs a project-written prompt, so the
 * workflow is then `repo`; an unresolvable command is `repo` too. The same holds for the
 * named scripts the workflows' exec nodes run (BUNDLED_SCRIPT_PACKS): each must resolve,
 * through the run's own script lookup (discoverScriptsForCwd), to the shipped script, with
 * every file of its pack (the `.shared` modules scripts import by relative path) holding
 * the shipped bytes. That lookup merges repo and home `.archon/scripts/` files over the
 * bundled ones by name, so a file named after a bundled script's qualified key replaces it.
 *
 * Discovery marks the expanded workflows that qualify (markShippedBundle); the executor
 * records the answer in the run's dispatch metadata once, so a resume never re-derives it.
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import {
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
} from './defaults/bundled-defaults';
import { isInlineScript } from './executor-shared';
import { isExecNode, isIncludeDirective, isLoopGroupNode } from './schemas';
import type { DagNode, IncludeDirective } from './schemas';
import type { ResolvedWorkflow } from './schemas/workflow';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let shippedHashes: Map<string, string> | undefined;

/** True when `content` is byte-identical to the shipped bundled workflow named `name`. */
export function isShippedBundledContent(name: string, content: string): boolean {
  shippedHashes ??= new Map(
    Object.entries(BUNDLED_WORKFLOWS).map(([n, text]) => [n, sha256(text)] as const)
  );
  const want = shippedHashes.get(name);
  return want !== undefined && want === sha256(content);
}

let shippedCommandHashes: Map<string, string> | undefined;

/** True when `content` is byte-identical to the shipped bundled command named `name`. */
export function isShippedBundledCommand(name: string, content: string): boolean {
  shippedCommandHashes ??= new Map(
    Object.entries(BUNDLED_COMMANDS).map(([n, text]) => [n, sha256(text)] as const)
  );
  const want = shippedCommandHashes.get(name);
  return want !== undefined && want === sha256(content);
}

/**
 * The named scripts a raw workflow's exec nodes run (loop bodies included), or
 * `undefined` when one cannot be known before the run: a single-line script whose only
 * inline marker is a `$` substitution may become a script name only at run time.
 */
export function namedScriptRefs(
  nodes: readonly (DagNode | IncludeDirective)[]
): Set<string> | undefined {
  const refs = new Set<string>();
  let unknowable = false;
  const visit = (node: DagNode | IncludeDirective): void => {
    if (isIncludeDirective(node)) return;
    if (isExecNode(node) && node.runtime !== 'sh') {
      if (!isInlineScript(node.script)) refs.add(node.script);
      else if (!isInlineScript(node.script.replaceAll('$', ''))) unknowable = true;
    }
    if (isLoopGroupNode(node)) for (const child of node.loop_group.nodes) visit(child);
  };
  for (const node of nodes) visit(node);
  return unknowable ? undefined : refs;
}

/**
 * True when `resolved` (what the run's script lookup returns for `name`) is the shipped
 * bundle's script `name`: the same runtime, at a pack root where every file the pack
 * ships holds the shipped bytes. Anything else, an unreadable file included, is false.
 * `packChecks` caches the per-root pack comparison across calls of one discovery.
 */
export async function isShippedBundledScript(
  name: string,
  resolved: { readonly path: string; readonly runtime: string } | undefined,
  packChecks: Map<string, Promise<boolean>> = new Map()
): Promise<boolean> {
  if (resolved === undefined) return false;
  for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
    const entry = bundled.scripts[name];
    if (entry === undefined) continue;
    const path = resolved.path.replaceAll('\\', '/');
    if (resolved.runtime !== entry.runtime || !path.endsWith(`/${entry.path}`)) return false;
    const root = path.slice(0, path.length - entry.path.length);
    const key = `${pack}\0${root}`;
    let check = packChecks.get(key);
    if (check === undefined) {
      check = (async (): Promise<boolean> => {
        for (const [relative, content] of Object.entries(bundled.files)) {
          if ((await readFile(`${root}${relative}`, 'utf-8')) !== content) return false;
        }
        return true;
      })().catch(() => false);
      packChecks.set(key, check);
    }
    return check;
  }
  return false;
}

/** The `include:` targets anywhere in a raw workflow's node lists (loop bodies included). */
export function includeTargets(nodes: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.include === 'string') out.push(record.include);
    for (const v of Object.values(record)) if (v && typeof v === 'object') walk(v);
  };
  walk(nodes);
  return out;
}

const shipped = new WeakSet();

/** Discovery: this expanded workflow and everything it includes are the shipped bundle's. */
export function markShippedBundle(workflow: ResolvedWorkflow): void {
  shipped.add(workflow);
}

/** Whether discovery marked this workflow object as the shipped bundle's (false if unsure). */
export function isShippedBundle(workflow: ResolvedWorkflow): boolean {
  return shipped.has(workflow);
}
