import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readTool } from './read';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'read-tool-test-'));
  await writeFile(join(testDir, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  await writeFile(join(testDir, 'empty.txt'), '');
  await mkdir(join(testDir, 'subdir'));
  await writeFile(join(testDir, 'subdir', 'nested.txt'), 'nested content');
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('readTool', () => {
  test('reads a file with line numbers', async () => {
    const result = await readTool({ file_path: join(testDir, 'hello.txt') }, testDir);
    expect(result).toContain('1\tline1');
    expect(result).toContain('2\tline2');
    expect(result).toContain('5\tline5');
  });

  test('reads with offset and limit', async () => {
    const result = await readTool(
      { file_path: join(testDir, 'hello.txt'), offset: 1, limit: 2 },
      testDir
    );
    expect(result).toContain('2\tline2');
    expect(result).toContain('3\tline3');
    expect(result).not.toContain('1\tline1');
    expect(result).not.toContain('4\tline4');
  });

  test('reads nested file within cwd', async () => {
    const result = await readTool({ file_path: join(testDir, 'subdir', 'nested.txt') }, testDir);
    expect(result).toContain('nested content');
  });

  test('returns empty file message for empty files', async () => {
    const result = await readTool({ file_path: join(testDir, 'empty.txt') }, testDir);
    expect(result).toContain('empty');
  });

  test('throws on file not found', async () => {
    await expect(
      readTool({ file_path: join(testDir, 'nonexistent.txt') }, testDir)
    ).rejects.toThrow('File not found');
  });

  test('throws on path traversal', async () => {
    await expect(
      readTool({ file_path: join(testDir, '..', '..', 'etc', 'passwd') }, testDir)
    ).rejects.toThrow('Path traversal blocked');
  });

  test('throws on missing file_path', async () => {
    await expect(readTool({}, testDir)).rejects.toThrow('file_path is required');
  });

  test('throws when file_path is empty string', async () => {
    await expect(readTool({ file_path: '' }, testDir)).rejects.toThrow('file_path is required');
  });

  test('throws on directory path', async () => {
    await expect(readTool({ file_path: join(testDir, 'subdir') }, testDir)).rejects.toThrow(
      'directory'
    );
  });
});
