import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { editTool } from './edit';

let testDir: string;
let testFile: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'));
  testFile = join(testDir, 'editable.txt');
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(testFile, 'hello world\nfoo bar\nbaz qux\n');
});

describe('editTool', () => {
  test('replaces a unique string', async () => {
    const result = await editTool(
      { file_path: testFile, old_string: 'foo bar', new_string: 'replaced' },
      testDir
    );
    expect(result).toContain('Successfully replaced 1 occurrence');

    const content = await readFile(testFile, 'utf-8');
    expect(content).toBe('hello world\nreplaced\nbaz qux\n');
  });

  test('throws when old_string not found', async () => {
    await expect(
      editTool({ file_path: testFile, old_string: 'nonexistent', new_string: 'x' }, testDir)
    ).rejects.toThrow('old_string not found');
  });

  test('throws when old_string is not unique (without replace_all)', async () => {
    await writeFile(testFile, 'aaa bbb aaa ccc aaa');
    await expect(
      editTool({ file_path: testFile, old_string: 'aaa', new_string: 'x' }, testDir)
    ).rejects.toThrow('appears 3 times');
  });

  test('replaces all occurrences with replace_all', async () => {
    await writeFile(testFile, 'aaa bbb aaa ccc aaa');
    const result = await editTool(
      { file_path: testFile, old_string: 'aaa', new_string: 'x', replace_all: true },
      testDir
    );
    expect(result).toContain('3 occurrences');

    const content = await readFile(testFile, 'utf-8');
    expect(content).toBe('x bbb x ccc x');
  });

  test('throws on file not found', async () => {
    await expect(
      editTool(
        { file_path: join(testDir, 'missing.txt'), old_string: 'a', new_string: 'b' },
        testDir
      )
    ).rejects.toThrow('File not found');
  });

  test('throws on path traversal', async () => {
    await expect(
      editTool(
        {
          file_path: join(testDir, '..', '..', 'etc', 'passwd'),
          old_string: 'root',
          new_string: 'x',
        },
        testDir
      )
    ).rejects.toThrow('Path traversal blocked');
  });

  test('throws on missing required params', async () => {
    await expect(editTool({ file_path: testFile, old_string: 'a' }, testDir)).rejects.toThrow(
      'new_string is required'
    );
    await expect(editTool({ file_path: testFile, new_string: 'a' }, testDir)).rejects.toThrow(
      'old_string is required'
    );
    await expect(editTool({ old_string: 'a', new_string: 'b' }, testDir)).rejects.toThrow(
      'file_path is required'
    );
  });

  test('handles multiline replacements', async () => {
    await writeFile(testFile, 'line1\nline2\nline3\n');
    await editTool(
      { file_path: testFile, old_string: 'line1\nline2', new_string: 'replaced' },
      testDir
    );
    const content = await readFile(testFile, 'utf-8');
    expect(content).toBe('replaced\nline3\n');
  });
});
