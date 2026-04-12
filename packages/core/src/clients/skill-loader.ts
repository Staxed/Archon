/**
 * Skill loader for non-Claude providers.
 *
 * Reads skill definitions from `.claude/skills/{name}/SKILL.md` directories
 * and produces provider-agnostic context: system prompt additions and tool allowlists.
 *
 * Claude SDK handles skills natively via AgentDefinition wrapping (dag-executor.ts:570-594).
 * This loader extracts the same information for providers that don't have SDK-level skill support.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';

const log = createLogger('skill-loader');

/**
 * Provider-agnostic skill context produced by the skill loader.
 * Injected into the tool loop as system prompt additions and tool filtering.
 */
export interface SkillContext {
  /** System prompt text extracted from skill SKILL.md files (markdown body after frontmatter). */
  systemPromptAdditions: string[];
  /** Tool names allowed by the skills. Empty array means no tool restrictions from skills. */
  toolAllowlist: string[];
}

/**
 * Parsed SKILL.md frontmatter fields relevant to the skill loader.
 */
interface SkillFrontmatter {
  name: string;
  description?: string;
  'allowed-tools'?: string;
  'argument-hint'?: string;
}

/**
 * Error thrown when a skill directory or SKILL.md file cannot be found.
 */
export class SkillNotFoundError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly searchPaths: string[]
  ) {
    super(
      `Skill '${skillName}' not found. Searched:\n${searchPaths.map(p => `  - ${p}`).join('\n')}`
    );
    this.name = 'SkillNotFoundError';
  }
}

/**
 * Error thrown when a SKILL.md file is malformed (missing frontmatter, etc.).
 */
export class SkillParseError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly reason: string
  ) {
    super(`Skill '${skillName}': ${reason}`);
    this.name = 'SkillParseError';
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expects `---` delimiters. Returns the frontmatter key-value pairs and the body.
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new Error('Missing YAML frontmatter (file must start with ---)');
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    throw new Error('Unterminated YAML frontmatter (missing closing ---)');
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  // Simple YAML parser for flat key-value pairs (handles multiline `|` values)
  const frontmatter: Record<string, string> = {};
  let currentKey = '';
  let currentValue = '';
  let inMultiline = false;
  let multilineIndent = 0;

  for (const line of yamlBlock.split('\n')) {
    if (inMultiline) {
      // Check if this line is still part of the multiline value
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent > multilineIndent || line.trim() === '') {
        currentValue += (currentValue ? '\n' : '') + line;
        continue;
      } else {
        // Multiline value ended
        frontmatter[currentKey] = currentValue.trim();
        inMultiline = false;
      }
    }

    const match = /^([a-zA-Z_-]+)\s*:\s*(.*)/.exec(line);
    if (match) {
      currentKey = match[1];
      const rawValue = match[2].trim();
      if (rawValue === '|' || rawValue === '>') {
        inMultiline = true;
        multilineIndent = line.length - line.trimStart().length;
        currentValue = '';
      } else {
        frontmatter[currentKey] = rawValue;
      }
    }
  }

  // Flush any remaining multiline value
  if (inMultiline && currentKey) {
    frontmatter[currentKey] = currentValue.trim();
  }

  if (!frontmatter.name) {
    throw new Error("Missing required 'name' field in frontmatter");
  }

  return { frontmatter: frontmatter as unknown as SkillFrontmatter, body };
}

/**
 * Parse the `allowed-tools` frontmatter value into an array of tool names.
 * Format: comma-separated tool names, optionally with patterns like `Bash(command:*)`.
 * Returns just the base tool names (strips patterns).
 */
function parseAllowedTools(value: string): string[] {
  if (!value.trim()) return [];

  return value
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => {
      // Strip patterns like `Bash(gh *)` → `Bash`
      const parenIndex = t.indexOf('(');
      return parenIndex !== -1 ? t.slice(0, parenIndex) : t;
    });
}

/**
 * Resolve a skill name to its SKILL.md file path.
 * Searches project-level first, then user-level.
 */
async function resolveSkillPath(skillName: string, cwd: string): Promise<string> {
  const projectPath = join(cwd, '.claude', 'skills', skillName, 'SKILL.md');
  const userPath = join(homedir(), '.claude', 'skills', skillName, 'SKILL.md');

  try {
    const projectStat = await stat(projectPath);
    if (projectStat.isFile()) return projectPath;
  } catch {
    // Not found at project level, try user level
  }

  try {
    const userStat = await stat(userPath);
    if (userStat.isFile()) return userPath;
  } catch {
    // Not found at user level either
  }

  throw new SkillNotFoundError(skillName, [projectPath, userPath]);
}

/**
 * Recursively collect all markdown files in a skill directory (for reference files).
 * Returns file paths relative to the skill directory.
 */
async function collectReferenceFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        files.push(fullPath);
      }
    }
  }

  await walk(skillDir);
  return files.sort();
}

/**
 * Load a single skill and extract its context.
 */
async function loadSingleSkill(
  skillName: string,
  cwd: string
): Promise<{ systemPrompt: string; allowedTools: string[] }> {
  const skillPath = await resolveSkillPath(skillName, cwd);
  const skillDir = join(skillPath, '..');

  log.debug({ skillName, skillPath }, 'skill.load_started');

  let content: string;
  try {
    content = await readFile(skillPath, 'utf-8');
  } catch (err) {
    throw new SkillParseError(skillName, `Failed to read SKILL.md: ${(err as Error).message}`);
  }

  let frontmatter: SkillFrontmatter;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err) {
    throw new SkillParseError(skillName, (err as Error).message);
  }

  // Collect reference files from subdirectories
  const refFiles = await collectReferenceFiles(skillDir);
  let referenceContent = '';
  for (const refPath of refFiles) {
    try {
      const refText = await readFile(refPath, 'utf-8');
      const relativePath = refPath.slice(skillDir.length + 1);
      referenceContent += `\n\n--- Reference: ${relativePath} ---\n${refText}`;
    } catch {
      // Skip unreadable reference files
      log.warn({ skillName, refPath }, 'skill.reference_read_failed');
    }
  }

  const systemPrompt = body + referenceContent;
  const allowedTools = frontmatter['allowed-tools']
    ? parseAllowedTools(frontmatter['allowed-tools'])
    : [];

  log.debug(
    { skillName, allowedToolsCount: allowedTools.length, hasReferences: refFiles.length > 0 },
    'skill.load_completed'
  );

  return { systemPrompt, allowedTools };
}

/**
 * Load skill definitions and produce a provider-agnostic SkillContext.
 *
 * @param skillNames - Array of skill names from workflow YAML `skills:` field
 * @param cwd - Working directory to resolve project-level skills from
 * @returns SkillContext with system prompt additions and merged tool allowlist
 * @throws SkillNotFoundError if a skill directory doesn't exist
 * @throws SkillParseError if a SKILL.md file is malformed
 */
export async function loadSkills(skillNames: string[], cwd: string): Promise<SkillContext> {
  if (skillNames.length === 0) {
    return { systemPromptAdditions: [], toolAllowlist: [] };
  }

  log.info({ skills: skillNames, cwd }, 'skill.batch_load_started');

  const systemPromptAdditions: string[] = [];
  const allAllowedTools: Set<string> = new Set();
  let hasAnyToolRestrictions = false;

  for (const skillName of skillNames) {
    const { systemPrompt, allowedTools } = await loadSingleSkill(skillName, cwd);

    if (systemPrompt) {
      systemPromptAdditions.push(systemPrompt);
    }

    if (allowedTools.length > 0) {
      hasAnyToolRestrictions = true;
      for (const tool of allowedTools) {
        allAllowedTools.add(tool);
      }
    }
  }

  // Only produce a toolAllowlist if at least one skill specified allowed-tools.
  // Empty toolAllowlist means "no restrictions from skills".
  const toolAllowlist = hasAnyToolRestrictions ? [...allAllowedTools] : [];

  log.info(
    {
      skills: skillNames,
      promptAdditions: systemPromptAdditions.length,
      toolAllowlistSize: toolAllowlist.length,
    },
    'skill.batch_load_completed'
  );

  return { systemPromptAdditions, toolAllowlist };
}
