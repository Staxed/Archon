import { readFile, stat } from 'fs/promises';
import { join, resolve, normalize } from 'path';

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB truncation limit

/** Supported output modes for the grep tool. */
type OutputMode = 'content' | 'files_with_matches' | 'count';

/**
 * Search file contents using regex patterns.
 * Supports filtering by glob pattern and file type.
 * Returns matching lines, file paths, or match counts depending on output_mode.
 */
export async function grepTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = params.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('Grep: pattern is required and must be a non-empty string.');
  }

  let regex: RegExp;
  try {
    const flags = params['-i'] === true ? 'i' : '';
    regex = new RegExp(pattern, flags);
  } catch (err) {
    const error = err as Error;
    throw new Error(`Grep: Invalid regex pattern: ${error.message}`);
  }

  const outputMode: OutputMode =
    typeof params.output_mode === 'string' &&
    ['content', 'files_with_matches', 'count'].includes(params.output_mode)
      ? (params.output_mode as OutputMode)
      : 'files_with_matches';

  // Determine the search root — must be within cwd
  let searchRoot = cwd;
  if (typeof params.path === 'string' && params.path.length > 0) {
    const normalizedCwd = normalize(resolve(cwd));
    const resolvedPath = normalize(resolve(cwd, params.path));
    if (!resolvedPath.startsWith(normalizedCwd + '/') && resolvedPath !== normalizedCwd) {
      throw new Error(
        `Grep: Path traversal blocked: "${params.path}" resolves outside the working directory.`
      );
    }
    searchRoot = resolvedPath;

    // If the path points to a single file, search just that file
    try {
      const s = await stat(resolvedPath);
      if (s.isFile()) {
        return await searchFile(resolvedPath, '', regex, outputMode, params);
      }
    } catch {
      // If stat fails, treat as directory and continue
    }
  }

  // Determine glob pattern for file discovery
  const fileGlob =
    typeof params.glob === 'string' && params.glob.length > 0
      ? params.glob
      : getTypeGlob(typeof params.type === 'string' ? params.type : undefined);

  const glob = new Bun.Glob(fileGlob);
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: searchRoot, onlyFiles: true })) {
    files.push(match);
  }

  const headLimit = typeof params.head_limit === 'number' ? params.head_limit : 250;
  const results: string[] = [];

  for (const file of files) {
    const fullPath = join(searchRoot, file);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue; // Skip unreadable files
    }

    const lines = content.split('\n');
    const matchingLines: { lineNum: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchingLines.push({ lineNum: i + 1, line: lines[i] });
      }
    }

    if (matchingLines.length === 0) continue;

    if (outputMode === 'files_with_matches') {
      results.push(file);
      if (headLimit > 0 && results.length >= headLimit) break;
    } else if (outputMode === 'count') {
      results.push(`${file}:${matchingLines.length}`);
      if (headLimit > 0 && results.length >= headLimit) break;
    } else {
      // content mode
      for (const match of matchingLines) {
        results.push(`${file}:${match.lineNum}:${match.line}`);
        if (headLimit > 0 && results.length >= headLimit) break;
      }
      if (headLimit > 0 && results.length >= headLimit) break;
    }
  }

  if (results.length === 0) {
    return `No matches found for pattern "${pattern}".`;
  }

  let output = results.join('\n');
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
  }

  return output;
}

/**
 * Search a single file and return results in the requested output mode.
 */
function searchFile(
  fullPath: string,
  relativePath: string,
  regex: RegExp,
  outputMode: OutputMode,
  params: Record<string, unknown>
): Promise<string> {
  return readFile(fullPath, 'utf-8').then(content => {
    const lines = content.split('\n');
    const matchingLines: { lineNum: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchingLines.push({ lineNum: i + 1, line: lines[i] });
      }
    }

    if (matchingLines.length === 0) {
      return `No matches found for pattern "${params.pattern}".`;
    }

    const displayPath = relativePath || fullPath;
    if (outputMode === 'files_with_matches') return displayPath;
    if (outputMode === 'count') return `${displayPath}:${matchingLines.length}`;
    return matchingLines.map(m => `${displayPath}:${m.lineNum}:${m.line}`).join('\n');
  });
}

/** Map file type shorthand to glob patterns. */
function getTypeGlob(type: string | undefined): string {
  if (!type) return '**/*';

  const typeMap: Record<string, string> = {
    js: '**/*.{js,jsx,mjs,cjs}',
    ts: '**/*.{ts,tsx,mts,cts}',
    py: '**/*.py',
    rust: '**/*.rs',
    go: '**/*.go',
    java: '**/*.java',
    md: '**/*.md',
    json: '**/*.json',
    yaml: '**/*.{yaml,yml}',
    html: '**/*.html',
    css: '**/*.{css,scss,less}',
    sh: '**/*.{sh,bash}',
  };

  return typeMap[type] ?? `**/*.${type}`;
}
