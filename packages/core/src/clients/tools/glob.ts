import { stat } from 'fs/promises';
import { join, resolve, normalize } from 'path';

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB truncation limit

/**
 * Find files matching a glob pattern within the working directory.
 * Returns matching file paths sorted by modification time (most recent first).
 */
export async function globTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = params.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('Glob: pattern is required and must be a non-empty string.');
  }

  // Determine the search root — must be within cwd
  let searchRoot = cwd;
  if (typeof params.path === 'string' && params.path.length > 0) {
    const normalizedCwd = normalize(resolve(cwd));
    const resolvedPath = normalize(resolve(cwd, params.path));
    if (!resolvedPath.startsWith(normalizedCwd + '/') && resolvedPath !== normalizedCwd) {
      throw new Error(
        `Glob: Path traversal blocked: "${params.path}" resolves outside the working directory.`
      );
    }
    searchRoot = resolvedPath;
  }

  const glob = new Bun.Glob(pattern);
  const entries: string[] = [];
  for (const match of glob.scanSync({ cwd: searchRoot, onlyFiles: true })) {
    entries.push(match);
  }

  // Stat each file to get modification time for sorting
  const withStats: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const fullPath = join(searchRoot, entry);
    try {
      const s = await stat(fullPath);
      withStats.push({ path: entry, mtimeMs: s.mtimeMs });
    } catch {
      // File may have been deleted between scan and stat — skip silently
      withStats.push({ path: entry, mtimeMs: 0 });
    }
  }

  // Sort by modification time, most recent first
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (withStats.length === 0) {
    return `No files matching pattern "${pattern}" found.`;
  }

  let output = withStats.map(entry => entry.path).join('\n');
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
  }

  return output;
}
