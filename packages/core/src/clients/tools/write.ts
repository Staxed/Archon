import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { validatePath } from './path-validation';

/**
 * Write content to a file. Creates the file (and parent directories) if they
 * don't exist, or overwrites the existing file.
 */
export async function writeTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const filePath = params.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Write: file_path is required and must be a non-empty string.');
  }

  const content = params.content;
  if (typeof content !== 'string') {
    throw new Error('Write: content is required and must be a string.');
  }

  const resolvedPath = validatePath(filePath, cwd);

  try {
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EACCES') {
      throw new Error(`Write: Permission denied: ${filePath}`);
    }
    throw new Error(`Write: Failed to write file: ${error.message}`);
  }

  return `Successfully wrote ${content.length} characters to ${filePath}`;
}
