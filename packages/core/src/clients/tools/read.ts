import { readFile } from 'fs/promises';
import { validatePath } from './path-validation';

/**
 * Read a file from the filesystem, returning content with line numbers.
 * Supports optional offset and limit for reading portions of large files.
 */
export async function readTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const filePath = params.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Read: file_path is required and must be a non-empty string.');
  }

  const resolvedPath = validatePath(filePath, cwd);

  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error(`Read: File not found: ${filePath}`);
    }
    if (error.code === 'EACCES') {
      throw new Error(`Read: Permission denied: ${filePath}`);
    }
    if (error.code === 'EISDIR') {
      throw new Error(`Read: Path is a directory, not a file: ${filePath}`);
    }
    throw new Error(`Read: Failed to read file: ${error.message}`);
  }

  if (content.length === 0) {
    return `(empty file: ${filePath})`;
  }

  const lines = content.split('\n');

  const offset = typeof params.offset === 'number' ? Math.max(0, Math.floor(params.offset)) : 0;
  const limit =
    typeof params.limit === 'number' ? Math.max(1, Math.floor(params.limit)) : lines.length;

  const selectedLines = lines.slice(offset, offset + limit);

  // Format with line numbers (1-based, matching cat -n style)
  return selectedLines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}
