import { describe, test, expect } from 'bun:test';
import {
  isLspSupported,
  fileExtToLspLanguage,
  buildLspWsUri,
  deriveProjectDir,
  getFileExtension,
  SUPPORTED_LSP_LANGUAGES,
} from './LspClient';

// ---------------------------------------------------------------------------
// isLspSupported
// ---------------------------------------------------------------------------

describe('isLspSupported', () => {
  test('returns true for all supported languages', () => {
    for (const lang of SUPPORTED_LSP_LANGUAGES) {
      expect(isLspSupported(lang)).toBe(true);
    }
  });

  test('returns false for null', () => {
    expect(isLspSupported(null)).toBe(false);
  });

  test('returns false for unsupported language', () => {
    expect(isLspSupported('cobol')).toBe(false);
    expect(isLspSupported('java')).toBe(false);
    expect(isLspSupported('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fileExtToLspLanguage
// ---------------------------------------------------------------------------

describe('fileExtToLspLanguage', () => {
  test('maps TypeScript extensions', () => {
    expect(fileExtToLspLanguage('ts')).toBe('typescript');
    expect(fileExtToLspLanguage('tsx')).toBe('typescript');
    expect(fileExtToLspLanguage('mts')).toBe('typescript');
    expect(fileExtToLspLanguage('cts')).toBe('typescript');
  });

  test('maps JavaScript extensions', () => {
    expect(fileExtToLspLanguage('js')).toBe('javascript');
    expect(fileExtToLspLanguage('jsx')).toBe('javascript');
    expect(fileExtToLspLanguage('mjs')).toBe('javascript');
    expect(fileExtToLspLanguage('cjs')).toBe('javascript');
  });

  test('maps Python extension', () => {
    expect(fileExtToLspLanguage('py')).toBe('python');
  });

  test('maps Go extension', () => {
    expect(fileExtToLspLanguage('go')).toBe('go');
  });

  test('maps Rust extension', () => {
    expect(fileExtToLspLanguage('rs')).toBe('rust');
  });

  test('maps Markdown extensions', () => {
    expect(fileExtToLspLanguage('md')).toBe('markdown');
    expect(fileExtToLspLanguage('mdx')).toBe('markdown');
  });

  test('returns null for unsupported extensions', () => {
    expect(fileExtToLspLanguage('txt')).toBeNull();
    expect(fileExtToLspLanguage('json')).toBeNull();
    expect(fileExtToLspLanguage('css')).toBeNull();
    expect(fileExtToLspLanguage('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildLspWsUri
// ---------------------------------------------------------------------------

describe('buildLspWsUri', () => {
  test('converts http to ws', () => {
    const uri = buildLspWsUri('http://localhost:3090', 'typescript', '/home/user/project');
    expect(uri).toMatch(/^ws:\/\//);
    expect(uri).toContain('language=typescript');
    expect(uri).toContain('projectDir=%2Fhome%2Fuser%2Fproject');
  });

  test('converts https to wss', () => {
    const uri = buildLspWsUri('https://localhost:3090', 'python', '/project');
    expect(uri).toMatch(/^wss:\/\//);
  });

  test('includes correct path', () => {
    const uri = buildLspWsUri('http://localhost:4200', 'go', '/project');
    expect(uri).toContain('localhost:4200/api/desktop/lsp');
  });
});

// ---------------------------------------------------------------------------
// deriveProjectDir
// ---------------------------------------------------------------------------

describe('deriveProjectDir', () => {
  test('returns parent directory of a file', () => {
    expect(deriveProjectDir('/home/user/project/src/main.ts')).toBe('/home/user/project/src');
  });

  test('returns root for root-level file', () => {
    expect(deriveProjectDir('/main.ts')).toBe('/');
  });

  test('returns / for bare filename', () => {
    expect(deriveProjectDir('main.ts')).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// getFileExtension
// ---------------------------------------------------------------------------

describe('getFileExtension', () => {
  test('extracts extension from simple path', () => {
    expect(getFileExtension('/home/user/main.ts')).toBe('ts');
  });

  test('extracts extension from dotted filename', () => {
    expect(getFileExtension('/path/to/file.test.ts')).toBe('ts');
  });

  test('returns empty string for no extension', () => {
    expect(getFileExtension('/path/to/Makefile')).toBe('');
  });

  test('returns empty string for empty path', () => {
    expect(getFileExtension('')).toBe('');
  });

  test('handles hidden files with extension', () => {
    expect(getFileExtension('/path/.eslintrc.json')).toBe('json');
  });
});
