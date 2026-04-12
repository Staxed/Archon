import { resolve, normalize, relative } from 'path';

/**
 * Validate that a file path resolves within the provided cwd.
 * Prevents directory traversal attacks (e.g., ../../etc/passwd).
 *
 * Uses `path.relative()` to avoid edge cases with string prefix matching
 * (e.g., sibling directories sharing a prefix like `/foo/bar` vs `/foo/barbaz`).
 *
 * @returns The resolved absolute path.
 * @throws If the path escapes the cwd boundary.
 */
export function validatePath(filePath: string, cwd: string): string {
  const normalizedCwd = normalize(resolve(cwd));
  const resolvedPath = normalize(resolve(cwd, filePath));

  // path.relative() returns a path starting with '..' if target is outside base
  const rel = relative(normalizedCwd, resolvedPath);
  if (rel.startsWith('..') || resolve(normalizedCwd, rel) !== resolvedPath) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside the working directory.`
    );
  }

  return resolvedPath;
}
