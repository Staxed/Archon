import { describe, it, expect } from 'bun:test';
import { validatePath } from './path-validation';

describe('validatePath', () => {
  const cwd = '/workspace/project';

  it('allows paths within cwd', () => {
    expect(validatePath('src/file.ts', cwd)).toBe('/workspace/project/src/file.ts');
  });

  it('allows cwd itself', () => {
    expect(validatePath('.', cwd)).toBe('/workspace/project');
  });

  it('allows already-absolute paths within cwd', () => {
    expect(validatePath('/workspace/project/deep/file.ts', cwd)).toBe(
      '/workspace/project/deep/file.ts'
    );
  });

  it('normalizes redundant segments', () => {
    expect(validatePath('src/../src/file.ts', cwd)).toBe('/workspace/project/src/file.ts');
  });

  it('blocks parent traversal', () => {
    expect(() => validatePath('../etc/passwd', cwd)).toThrow('Path traversal blocked');
  });

  it('blocks absolute paths outside cwd', () => {
    expect(() => validatePath('/etc/passwd', cwd)).toThrow('Path traversal blocked');
  });

  it('blocks sibling directory with shared prefix', () => {
    // /workspace/project-evil must NOT pass when cwd is /workspace/project
    expect(() => validatePath('/workspace/project-evil/file', cwd)).toThrow(
      'Path traversal blocked'
    );
  });

  it('blocks double-dot sequences that escape cwd', () => {
    expect(() => validatePath('src/../../etc/passwd', cwd)).toThrow('Path traversal blocked');
  });

  it('blocks encoded-style traversal after normalization', () => {
    expect(() => validatePath('foo/../../../etc/shadow', cwd)).toThrow('Path traversal blocked');
  });
});
