import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkills, SkillNotFoundError, SkillParseError } from './skill-loader';

describe('skill-loader', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'skill-loader-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Helper to create a skill directory with SKILL.md */
  async function createSkill(
    name: string,
    frontmatter: Record<string, string>,
    body: string,
    references?: Record<string, string>
  ): Promise<void> {
    const skillDir = join(testDir, '.claude', 'skills', name);
    await mkdir(skillDir, { recursive: true });

    const fmLines = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const content = `---\n${fmLines}\n---\n\n${body}`;
    await writeFile(join(skillDir, 'SKILL.md'), content);

    if (references) {
      for (const [path, text] of Object.entries(references)) {
        const refPath = join(skillDir, path);
        await mkdir(join(refPath, '..'), { recursive: true });
        await writeFile(refPath, text);
      }
    }
  }

  test('loads a single skill with system prompt', async () => {
    await createSkill('my-skill', { name: 'my-skill' }, 'Do the thing.\n\nBe careful.');

    const result = await loadSkills(['my-skill'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(1);
    expect(result.systemPromptAdditions[0]).toContain('Do the thing.');
    expect(result.systemPromptAdditions[0]).toContain('Be careful.');
    expect(result.toolAllowlist).toEqual([]);
  });

  test('loads a skill with allowed-tools', async () => {
    await createSkill(
      'restricted-skill',
      { name: 'restricted-skill', 'allowed-tools': 'Bash, Read, Grep' },
      'Only use these tools.'
    );

    const result = await loadSkills(['restricted-skill'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(1);
    expect(result.toolAllowlist).toEqual(['Bash', 'Read', 'Grep']);
  });

  test('strips patterns from allowed-tools (e.g., Bash(gh *))', async () => {
    await createSkill(
      'pattern-skill',
      { name: 'pattern-skill', 'allowed-tools': 'Bash(gh *), Read, Glob' },
      'Pattern skill.'
    );

    const result = await loadSkills(['pattern-skill'], testDir);

    expect(result.toolAllowlist).toEqual(['Bash', 'Read', 'Glob']);
  });

  test('loads multiple skills and merges tool allowlists', async () => {
    await createSkill(
      'skill-a',
      { name: 'skill-a', 'allowed-tools': 'Bash, Read' },
      'Skill A content.'
    );
    await createSkill(
      'skill-b',
      { name: 'skill-b', 'allowed-tools': 'Read, Write, Edit' },
      'Skill B content.'
    );

    const result = await loadSkills(['skill-a', 'skill-b'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(2);
    expect(result.systemPromptAdditions[0]).toContain('Skill A content.');
    expect(result.systemPromptAdditions[1]).toContain('Skill B content.');
    // Merged and deduplicated
    expect(result.toolAllowlist.sort()).toEqual(['Bash', 'Edit', 'Read', 'Write']);
  });

  test('no tool restrictions when no skill specifies allowed-tools', async () => {
    await createSkill('open-skill-1', { name: 'open-skill-1' }, 'No restrictions.');
    await createSkill('open-skill-2', { name: 'open-skill-2' }, 'Also no restrictions.');

    const result = await loadSkills(['open-skill-1', 'open-skill-2'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(2);
    expect(result.toolAllowlist).toEqual([]);
  });

  test('includes reference files from subdirectories', async () => {
    await createSkill('ref-skill', { name: 'ref-skill' }, 'Main content.', {
      'references/guide.md': '# Guide\n\nSome reference content.',
      'examples/example1.md': '# Example 1\n\nAn example.',
    });

    const result = await loadSkills(['ref-skill'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(1);
    const prompt = result.systemPromptAdditions[0];
    expect(prompt).toContain('Main content.');
    expect(prompt).toContain('--- Reference: examples/example1.md ---');
    expect(prompt).toContain('--- Reference: references/guide.md ---');
    expect(prompt).toContain('Some reference content.');
    expect(prompt).toContain('An example.');
  });

  test('throws SkillNotFoundError for missing skill', async () => {
    await expect(loadSkills(['nonexistent-skill'], testDir)).rejects.toThrow(SkillNotFoundError);
    try {
      await loadSkills(['nonexistent-skill'], testDir);
    } catch (err) {
      expect(err).toBeInstanceOf(SkillNotFoundError);
      expect((err as SkillNotFoundError).skillName).toBe('nonexistent-skill');
      expect((err as SkillNotFoundError).searchPaths).toHaveLength(2);
    }
  });

  test('throws SkillParseError for missing frontmatter', async () => {
    const skillDir = join(testDir, '.claude', 'skills', 'bad-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'No frontmatter here.');

    await expect(loadSkills(['bad-skill'], testDir)).rejects.toThrow(SkillParseError);
  });

  test('throws SkillParseError for missing name in frontmatter', async () => {
    const skillDir = join(testDir, '.claude', 'skills', 'no-name');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: no name field\n---\n\nBody.');

    await expect(loadSkills(['no-name'], testDir)).rejects.toThrow(SkillParseError);
  });

  test('returns empty context for empty skill list', async () => {
    const result = await loadSkills([], testDir);

    expect(result.systemPromptAdditions).toEqual([]);
    expect(result.toolAllowlist).toEqual([]);
  });

  test('handles multiline description in frontmatter', async () => {
    const skillDir = join(testDir, '.claude', 'skills', 'multiline');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: multiline\ndescription: |\n  Line 1\n  Line 2\n---\n\nBody content.'
    );

    const result = await loadSkills(['multiline'], testDir);

    expect(result.systemPromptAdditions).toHaveLength(1);
    expect(result.systemPromptAdditions[0]).toContain('Body content.');
  });

  test('handles skill with only allowed-tools from some skills in a batch', async () => {
    await createSkill('open-skill', { name: 'open-skill' }, 'Open skill.');
    await createSkill(
      'restricted-skill',
      { name: 'restricted-skill', 'allowed-tools': 'Bash' },
      'Restricted skill.'
    );

    const result = await loadSkills(['open-skill', 'restricted-skill'], testDir);

    // When any skill specifies restrictions, the merged allowlist applies
    expect(result.toolAllowlist).toEqual(['Bash']);
  });
});
