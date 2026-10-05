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
 * workflow is then `repo`; an unresolvable command is `repo` too.
 *
 * Discovery marks the expanded workflows that qualify (markShippedBundle); the executor
 * records the answer in the run's dispatch metadata once, so a resume never re-derives it.
 */
import { createHash } from 'crypto';
import { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
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
