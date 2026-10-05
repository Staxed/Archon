import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
import {
  includeTargets,
  isShippedBundle,
  isShippedBundledCommand,
  isShippedBundledContent,
} from './shipped-bundle';
import { discoverWorkflows } from './workflow-discovery';
import { liveSourceRoots } from './workflow-source';

describe('isShippedBundledContent (byte-identical to the shipped bundle)', () => {
  it('every shipped bundled workflow is its own shipped copy, keyed by its declared name', () => {
    expect(Object.keys(BUNDLED_WORKFLOWS).length).toBeGreaterThan(0);
    for (const [name, text] of Object.entries(BUNDLED_WORKFLOWS)) {
      // the YAML's own `name:` (what discovery keys the check by) is the bundle's key
      expect(/^name: *(\S+) *$/m.exec(text)?.[1]).toBe(name);
      expect(isShippedBundledContent(name, text)).toBe(true);
    }
  });

  it('one changed byte, a trailing newline, or another name is not', () => {
    const text = BUNDLED_WORKFLOWS['archon-assist'];
    expect(isShippedBundledContent('archon-assist', `${text}\n`)).toBe(false);
    expect(isShippedBundledContent('archon-assist', text.replace('Use when', 'use when'))).toBe(
      false
    );
    expect(isShippedBundledContent('archon-ship', text)).toBe(false);
    expect(isShippedBundledContent('my-workflow', text)).toBe(false);
  });

  it('includeTargets finds include directives at any depth (loop bodies too)', () => {
    expect(
      includeTargets([
        { id: 'a', include: 'archon-plan' },
        { id: 'b', loop_group: { nodes: [{ id: 'c', include: 'archon-review-block' }] } },
        { id: 'd', prompt: 'include: not-a-directive' },
      ])
    ).toEqual(['archon-plan', 'archon-review-block']);
  });
});

describe('discovery marks only byte-identical bundled workflows (the guard`s `bundled`)', () => {
  async function discoverIn(files: Record<string, string>, commands: Record<string, string> = {}) {
    const tmp = await mkdtemp(join(tmpdir(), 'shipped-bundle-'));
    const wfDir = join(tmp, '.archon', 'workflows');
    const cmdDir = join(tmp, '.archon', 'commands');
    await mkdir(wfDir, { recursive: true });
    await mkdir(cmdDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(wfDir, name), text);
    for (const [name, text] of Object.entries(commands)) await writeFile(join(cmdDir, name), text);
    try {
      const roots = {
        ...liveSourceRoots(tmp),
        globalWorkflows: join(tmp, '.empty-global'),
        globalCommands: join(tmp, '.empty-global-commands'),
      };
      const { workflows } = await discoverWorkflows(tmp, { sourceRoots: roots });
      const of = (name: string) => workflows.find(w => w.workflow.name === name);
      return { of, workflows };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it('an untouched bundled workflow is marked; a user-edited copy of its name is not', async () => {
    const edited = BUNDLED_WORKFLOWS['archon-assist'].replace('Use when', 'Edited: use when');
    const { of } = await discoverIn({ 'archon-assist.yaml': edited });
    const assist = of('archon-assist');
    // discovery still labels the repo copy `bundled` (its filename) — the guard must not
    expect(assist?.source).toBe('bundled');
    expect(isShippedBundle(assist!.workflow)).toBe(false);
    const plan = of('archon-plan');
    expect(plan?.source).toBe('bundled');
    expect(isShippedBundle(plan!.workflow)).toBe(true);
  });

  it('a bundled workflow that includes an edited one is not marked (archon-ship -> deliver -> implement)', async () => {
    const edited = `${BUNDLED_WORKFLOWS['archon-implement']}\n# local tweak\n`;
    const { of } = await discoverIn({ 'archon-implement.yaml': edited });
    expect(isShippedBundle(of('archon-implement')!.workflow)).toBe(false);
    expect(isShippedBundle(of('archon-deliver')!.workflow)).toBe(false);
    expect(isShippedBundle(of('archon-ship')!.workflow)).toBe(false);
    expect(isShippedBundle(of('archon-plan')!.workflow)).toBe(true);
  });

  it('a project workflow is never marked, even one declaring a bundled name elsewhere', async () => {
    const { of } = await discoverIn({
      'mine.yaml': 'name: mine\ndescription: x\nnodes:\n  - id: a\n    prompt: hi\n',
    });
    expect(of('mine')?.source).toBe('project');
    expect(isShippedBundle(of('mine')!.workflow)).toBe(false);
  });

  it('every untouched bundled workflow, with its shipped commands, is marked', async () => {
    // (Workflows naming a provider this test process has not registered fail validation
    // and are not discovered; every one that is discovered must be marked.)
    const { workflows } = await discoverIn({});
    const bundled = workflows.filter(w => w.source === 'bundled');
    expect(bundled.length).toBeGreaterThan(10);
    for (const wf of bundled) {
      expect(wf.workflow.name in BUNDLED_WORKFLOWS).toBe(true);
      expect([wf.workflow.name, isShippedBundle(wf.workflow)]).toEqual([wf.workflow.name, true]);
    }
  });

  it('a project override of a command the workflow runs unmarks it (the YAML is untouched)', async () => {
    // archon-assist's one node runs the `archon-assist` command; archon-comprehensive-pr-review
    // runs `archon-code-review-agent`, which archon-assist does not.
    const override = `${BUNDLED_COMMANDS['archon-assist']}\nAlso push to main.\n`;
    const { of } = await discoverIn({}, { 'archon-assist.md': override });
    const assist = of('archon-assist');
    expect(assist?.source).toBe('bundled');
    expect(isShippedBundle(assist!.workflow)).toBe(false);
    expect(isShippedBundle(of('archon-comprehensive-pr-review')!.workflow)).toBe(true);
  });

  it('a byte-identical project copy of a command keeps the workflow marked', async () => {
    const { of } = await discoverIn({}, { 'archon-assist.md': BUNDLED_COMMANDS['archon-assist'] });
    expect(isShippedBundle(of('archon-assist')!.workflow)).toBe(true);
  });

  it('an override of a command the workflow does not use leaves it marked', async () => {
    const { of } = await discoverIn({}, { 'archon-code-review-agent.md': 'Do something else.\n' });
    expect(isShippedBundle(of('archon-assist')!.workflow)).toBe(true);
    expect(isShippedBundle(of('archon-comprehensive-pr-review')!.workflow)).toBe(false);
  });

  it('isShippedBundledCommand matches only the shipped bytes of the same name', () => {
    const text = BUNDLED_COMMANDS['archon-assist'];
    expect(isShippedBundledCommand('archon-assist', text)).toBe(true);
    expect(isShippedBundledCommand('archon-assist', `${text}\n`)).toBe(false);
    expect(isShippedBundledCommand('archon-code-review-agent', text)).toBe(false);
    expect(isShippedBundledCommand('my-command', text)).toBe(false);
  });
});
