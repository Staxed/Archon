import { normalize, relative, resolve } from 'node:path';

/**
 * Validate that a file path resolves within `cwd`, the node's working directory.
 *
 * Uses `path.relative()` rather than string prefix matching so a sibling that
 * shares a prefix (`/foo/bar` vs `/foo/barbaz`) is not mistaken for a child.
 *
 * @returns The resolved absolute path.
 * @throws If the path escapes the cwd boundary.
 */
export function validatePath(filePath: string, cwd: string): string {
  const normalizedCwd = normalize(resolve(cwd));
  const resolvedPath = normalize(resolve(cwd, filePath));
  const rel = relative(normalizedCwd, resolvedPath);
  if (rel.startsWith('..') || resolve(normalizedCwd, rel) !== resolvedPath) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside the working directory.`
    );
  }
  return resolvedPath;
}
