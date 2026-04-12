import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { globTool } from './glob';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'glob-tool-test-'));
  // Create test file structure
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'src', 'nested'), { recursive: true });
  await writeFile(join(tempDir, 'foo.ts'), 'export const foo = 1;');
  await writeFile(join(tempDir, 'bar.ts'), 'export const bar = 2;');
  await writeFile(join(tempDir, 'readme.md'), '# Hello');
  await writeFile(join(tempDir, 'src', 'index.ts'), 'console.log("hello");');
  await writeFile(join(tempDir, 'src', 'nested', 'deep.ts'), 'export const deep = true;');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('globTool', () => {
  test('finds files matching a pattern', async () => {
    const result = await globTool({ pattern: '*.ts' }, tempDir);
    expect(result).toContain('foo.ts');
    expect(result).toContain('bar.ts');
    expect(result).not.toContain('readme.md');
  });

  test('finds files recursively with **', async () => {
    const result = await globTool({ pattern: '**/*.ts' }, tempDir);
    expect(result).toContain('foo.ts');
    expect(result).toContain('bar.ts');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/nested/deep.ts');
  });

  test('respects path parameter', async () => {
    const result = await globTool({ pattern: '*.ts', path: 'src' }, tempDir);
    expect(result).toContain('index.ts');
    expect(result).not.toContain('foo.ts');
  });

  test('returns no-match message when nothing found', async () => {
    const result = await globTool({ pattern: '*.xyz' }, tempDir);
    expect(result).toContain('No files matching pattern');
  });

  test('blocks path traversal', async () => {
    expect(globTool({ pattern: '*.ts', path: '../../' }, tempDir)).rejects.toThrow(
      'Path traversal blocked'
    );
  });

  test('throws on missing pattern', async () => {
    expect(globTool({}, tempDir)).rejects.toThrow('pattern is required');
  });

  test('throws on empty pattern', async () => {
    expect(globTool({ pattern: '' }, tempDir)).rejects.toThrow('pattern is required');
  });

  test('results are sorted by modification time', async () => {
    // Touch bar.ts to make it newer
    await writeFile(join(tempDir, 'bar.ts'), 'export const bar = 3;');
    // Small delay to ensure different mtime
    await new Promise(resolve => setTimeout(resolve, 50));
    await writeFile(join(tempDir, 'foo.ts'), 'export const foo = 2;');

    const result = await globTool({ pattern: '*.ts' }, tempDir);
    const lines = result.split('\n');
    // foo.ts should appear before bar.ts since it was modified more recently
    const fooIndex = lines.findIndex(l => l.includes('foo.ts'));
    const barIndex = lines.findIndex(l => l.includes('bar.ts'));
    expect(fooIndex).toBeLessThan(barIndex);
  });
});
