import { readFile, writeFile } from 'fs/promises';
import { validatePath } from './path-validation';

/**
 * Perform an exact string replacement in a file.
 * By default, old_string must appear exactly once in the file.
 * Set replace_all to true to replace every occurrence.
 */
export async function editTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const filePath = params.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Edit: file_path is required and must be a non-empty string.');
  }

  const oldString = params.old_string;
  if (typeof oldString !== 'string') {
    throw new Error('Edit: old_string is required and must be a string.');
  }

  const newString = params.new_string;
  if (typeof newString !== 'string') {
    throw new Error('Edit: new_string is required and must be a string.');
  }

  const replaceAll = params.replace_all === true;

  const resolvedPath = validatePath(filePath, cwd);

  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error(`Edit: File not found: ${filePath}`);
    }
    if (error.code === 'EACCES') {
      throw new Error(`Edit: Permission denied: ${filePath}`);
    }
    throw new Error(`Edit: Failed to read file: ${error.message}`);
  }

  if (!content.includes(oldString)) {
    throw new Error(
      `Edit: old_string not found in ${filePath}. Ensure the string matches exactly (including whitespace and indentation).`
    );
  }

  if (!replaceAll) {
    const firstIndex = content.indexOf(oldString);
    const secondIndex = content.indexOf(oldString, firstIndex + 1);
    if (secondIndex !== -1) {
      const occurrences = content.split(oldString).length - 1;
      throw new Error(
        `Edit: old_string appears ${occurrences} times in ${filePath}. ` +
          'Provide a more unique string or set replace_all to true.'
      );
    }
  }

  let updated: string;
  if (replaceAll) {
    updated = content.split(oldString).join(newString);
  } else {
    const index = content.indexOf(oldString);
    updated = content.substring(0, index) + newString + content.substring(index + oldString.length);
  }

  try {
    await writeFile(resolvedPath, updated, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    throw new Error(`Edit: Failed to write file: ${error.message}`);
  }

  const replacements = replaceAll ? content.split(oldString).length - 1 : 1;
  return `Successfully replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${filePath}`;
}
