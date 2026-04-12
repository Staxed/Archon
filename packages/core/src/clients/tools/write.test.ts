import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeTool } from './write';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'write-tool-test-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('writeTool', () => {
  test('creates a new file', async () => {
    const result = await writeTool(
      { file_path: join(testDir, 'new.txt'), content: 'hello world' },
      testDir
    );
    expect(result).toContain('Successfully wrote');
    expect(result).toContain('11 characters');

    const content = await readFile(join(testDir, 'new.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  test('overwrites existing file', async () => {
    await writeTool({ file_path: join(testDir, 'overwrite.txt'), content: 'first' }, testDir);
    await writeTool({ file_path: join(testDir, 'overwrite.txt'), content: 'second' }, testDir);

    const content = await readFile(join(testDir, 'overwrite.txt'), 'utf-8');
    expect(content).toBe('second');
  });

  test('creates parent directories', async () => {
    const result = await writeTool(
      { file_path: join(testDir, 'deep', 'nested', 'file.txt'), content: 'deep' },
      testDir
    );
    expect(result).toContain('Successfully wrote');

    const content = await readFile(join(testDir, 'deep', 'nested', 'file.txt'), 'utf-8');
    expect(content).toBe('deep');
  });

  test('writes empty content', async () => {
    const result = await writeTool({ file_path: join(testDir, 'empty.txt'), content: '' }, testDir);
    expect(result).toContain('0 characters');
  });

  test('throws on path traversal', async () => {
    await expect(
      writeTool({ file_path: join(testDir, '..', '..', 'escape.txt'), content: 'bad' }, testDir)
    ).rejects.toThrow('Path traversal blocked');
  });

  test('throws on missing file_path', async () => {
    await expect(writeTool({ content: 'test' }, testDir)).rejects.toThrow('file_path is required');
  });

  test('throws on missing content', async () => {
    await expect(writeTool({ file_path: join(testDir, 'test.txt') }, testDir)).rejects.toThrow(
      'content is required'
    );
  });
});
