import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { bashTool } from './bash';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bash-tool-test-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('bashTool', () => {
  test('executes a simple command and returns stdout', async () => {
    const result = await bashTool({ command: 'echo hello world' }, tempDir);
    expect(result.trim()).toBe('hello world');
  });

  test('captures stderr', async () => {
    const result = await bashTool({ command: 'echo error >&2' }, tempDir);
    expect(result).toContain('[stderr]');
    expect(result).toContain('error');
  });

  test('runs commands in the provided cwd', async () => {
    const result = await bashTool({ command: 'pwd' }, tempDir);
    expect(result.trim()).toBe(tempDir);
  });

  test('handles non-zero exit codes with output', async () => {
    const result = await bashTool({ command: 'echo "some output" && exit 1' }, tempDir);
    expect(result).toContain('exit code: non-zero');
    expect(result).toContain('some output');
  });

  test('returns no-output message for silent commands', async () => {
    const result = await bashTool({ command: 'true' }, tempDir);
    expect(result).toBe('(command completed with no output)');
  });

  test('enforces timeout', async () => {
    expect(bashTool({ command: 'sleep 10', timeout: 500 }, tempDir)).rejects.toThrow('timed out');
  }, 10000);

  test('clamps timeout to max 600s', async () => {
    // This should not throw about invalid timeout — it should clamp to max
    const result = await bashTool({ command: 'echo "ok"', timeout: 999999 }, tempDir);
    expect(result.trim()).toBe('ok');
  });

  test('throws on missing command', async () => {
    expect(bashTool({}, tempDir)).rejects.toThrow('command is required');
  });

  test('throws on empty command', async () => {
    expect(bashTool({ command: '' }, tempDir)).rejects.toThrow('command is required');
  });

  test('handles multi-line output', async () => {
    const result = await bashTool({ command: 'echo "line1"; echo "line2"; echo "line3"' }, tempDir);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
  });
});
