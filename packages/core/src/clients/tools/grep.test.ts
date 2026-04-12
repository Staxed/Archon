import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { grepTool } from './grep';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'));
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await writeFile(join(tempDir, 'foo.ts'), 'const foo = 1;\nconst bar = 2;\nfoo();\n');
  await writeFile(
    join(tempDir, 'bar.ts'),
    'import { foo } from "./foo";\nexport const baz = foo;\n'
  );
  await writeFile(join(tempDir, 'readme.md'), '# My Project\n\nThis uses foo extensively.\n');
  await writeFile(
    join(tempDir, 'src', 'index.ts'),
    'const result = foo + bar;\nconsole.log(result);\n'
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('grepTool', () => {
  test('finds matching files (files_with_matches mode)', async () => {
    const result = await grepTool({ pattern: 'foo' }, tempDir);
    expect(result).toContain('foo.ts');
    expect(result).toContain('bar.ts');
    expect(result).toContain('readme.md');
  });

  test('returns matching lines (content mode)', async () => {
    const result = await grepTool({ pattern: 'foo', output_mode: 'content' }, tempDir);
    expect(result).toContain('const foo = 1;');
    expect(result).toContain('foo()');
  });

  test('returns match counts (count mode)', async () => {
    const result = await grepTool({ pattern: 'foo', output_mode: 'count' }, tempDir);
    // foo.ts has 2 lines matching "foo"
    expect(result).toContain('foo.ts:2');
  });

  test('supports case-insensitive search', async () => {
    const result = await grepTool(
      { pattern: 'my project', '-i': true, output_mode: 'content' },
      tempDir
    );
    expect(result).toContain('# My Project');
  });

  test('filters by glob pattern', async () => {
    const result = await grepTool({ pattern: 'foo', glob: '*.ts' }, tempDir);
    expect(result).toContain('foo.ts');
    expect(result).not.toContain('readme.md');
  });

  test('filters by type', async () => {
    const result = await grepTool({ pattern: 'foo', type: 'md' }, tempDir);
    expect(result).toContain('readme.md');
    expect(result).not.toContain('foo.ts');
  });

  test('searches within a specific path', async () => {
    const result = await grepTool({ pattern: 'foo', path: 'src' }, tempDir);
    expect(result).toContain('index.ts');
    expect(result).not.toContain('foo.ts');
  });

  test('searches a single file when path points to a file', async () => {
    const result = await grepTool(
      { pattern: 'foo', path: 'foo.ts', output_mode: 'content' },
      tempDir
    );
    expect(result).toContain('const foo = 1;');
    expect(result).toContain('foo()');
  });

  test('returns no-match message when nothing found', async () => {
    const result = await grepTool({ pattern: 'nonexistent_xyz' }, tempDir);
    expect(result).toContain('No matches found');
  });

  test('throws on invalid regex', async () => {
    expect(grepTool({ pattern: '[invalid' }, tempDir)).rejects.toThrow('Invalid regex pattern');
  });

  test('throws on missing pattern', async () => {
    expect(grepTool({}, tempDir)).rejects.toThrow('pattern is required');
  });

  test('blocks path traversal', async () => {
    expect(grepTool({ pattern: 'foo', path: '../../../etc' }, tempDir)).rejects.toThrow(
      'Path traversal blocked'
    );
  });
});
