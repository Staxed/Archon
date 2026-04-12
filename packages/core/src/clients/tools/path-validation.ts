import { resolve, normalize } from 'path';

/**
 * Validate that a file path resolves within the provided cwd.
 * Prevents directory traversal attacks (e.g., ../../etc/passwd).
 *
 * @returns The resolved absolute path.
 * @throws If the path escapes the cwd boundary.
 */
export function validatePath(filePath: string, cwd: string): string {
  const normalizedCwd = normalize(resolve(cwd));
  const resolvedPath = normalize(resolve(cwd, filePath));

  if (!resolvedPath.startsWith(normalizedCwd + '/') && resolvedPath !== normalizedCwd) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside the working directory.`
    );
  }

  return resolvedPath;
}
