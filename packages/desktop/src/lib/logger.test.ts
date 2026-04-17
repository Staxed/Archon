import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getLogDir,
  getLogPath,
  getRotatedPath,
  computeRotationPlan,
  maskValue,
  isSecretKey,
  maskSecrets,
  formatLogLine,
  DesktopLogger,
  MAX_LOG_SIZE_BYTES,
  MAX_ROTATED_FILES,
  LOG_FILENAME,
} from './logger';
import type { LogFileSystem } from './logger';

// --- getLogDir ---

describe('getLogDir', () => {
  test('returns Windows path with APPDATA', () => {
    expect(getLogDir('win32', 'C:\\Users\\user', 'C:\\Users\\user\\AppData\\Roaming')).toBe(
      'C:\\Users\\user\\AppData\\Roaming\\ArchonDesktop\\logs'
    );
  });

  test('returns Windows path without APPDATA (fallback)', () => {
    expect(getLogDir('win32', 'C:\\Users\\user')).toBe(
      'C:\\Users\\user\\AppData\\Roaming\\ArchonDesktop\\logs'
    );
  });

  test('returns macOS path', () => {
    expect(getLogDir('darwin', '/Users/user')).toBe('/Users/user/Library/Logs/ArchonDesktop');
  });

  test('returns Linux path', () => {
    expect(getLogDir('linux', '/home/user')).toBe('/home/user/.local/share/ArchonDesktop/logs');
  });
});

// --- getLogPath ---

describe('getLogPath', () => {
  test('returns full Windows log path', () => {
    const p = getLogPath('win32', 'C:\\Users\\user', 'C:\\Users\\user\\AppData\\Roaming');
    expect(p).toBe(`C:\\Users\\user\\AppData\\Roaming\\ArchonDesktop\\logs\\${LOG_FILENAME}`);
  });

  test('returns full macOS log path', () => {
    const p = getLogPath('darwin', '/Users/user');
    expect(p).toBe(`/Users/user/Library/Logs/ArchonDesktop/${LOG_FILENAME}`);
  });
});

// --- getRotatedPath ---

describe('getRotatedPath', () => {
  test('appends .N suffix', () => {
    expect(getRotatedPath('/var/log/app.log', 1)).toBe('/var/log/app.log.1');
    expect(getRotatedPath('/var/log/app.log', 5)).toBe('/var/log/app.log.5');
  });
});

// --- computeRotationPlan ---

describe('computeRotationPlan', () => {
  test('produces correct rotation sequence', () => {
    const plan = computeRotationPlan('/tmp/test.log', 3);
    expect(plan).toEqual([
      { from: '/tmp/test.log.3', to: null }, // delete oldest
      { from: '/tmp/test.log.2', to: '/tmp/test.log.3' }, // shift .2 → .3
      { from: '/tmp/test.log.1', to: '/tmp/test.log.2' }, // shift .1 → .2
      { from: '/tmp/test.log', to: '/tmp/test.log.1' }, // current → .1
    ]);
  });

  test('default max files is 5', () => {
    const plan = computeRotationPlan('/tmp/test.log');
    // Should delete .5, shift .4→.5, .3→.4, .2→.3, .1→.2, current→.1
    expect(plan).toHaveLength(MAX_ROTATED_FILES + 1);
    expect(plan[0]).toEqual({ from: '/tmp/test.log.5', to: null });
    expect(plan[plan.length - 1]).toEqual({ from: '/tmp/test.log', to: '/tmp/test.log.1' });
  });
});

// --- maskValue ---

describe('maskValue', () => {
  test('masks long values showing first 8 chars', () => {
    expect(maskValue('sk-1234567890abcdef')).toBe('sk-12345...');
  });

  test('masks short values completely', () => {
    expect(maskValue('short')).toBe('***');
    expect(maskValue('12345678')).toBe('***');
  });
});

// --- isSecretKey ---

describe('isSecretKey', () => {
  test('detects secret-like keys', () => {
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('API_KEY')).toBe(true);
    expect(isSecretKey('api-key')).toBe(true);
    expect(isSecretKey('token')).toBe(true);
    expect(isSecretKey('accessToken')).toBe(true);
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('secret')).toBe(true);
    expect(isSecretKey('credential')).toBe(true);
    expect(isSecretKey('authorization')).toBe(true);
  });

  test('does not flag normal keys', () => {
    expect(isSecretKey('name')).toBe(false);
    expect(isSecretKey('host')).toBe(false);
    expect(isSecretKey('event')).toBe(false);
  });
});

// --- maskSecrets ---

describe('maskSecrets', () => {
  test('masks secret fields', () => {
    const input = { apiKey: 'sk-1234567890abcdef', name: 'test' };
    const result = maskSecrets(input);
    expect(result.apiKey).toBe('sk-12345...');
    expect(result.name).toBe('test');
  });

  test('masks nested secret fields', () => {
    const input = { config: { token: 'abc123456789xyz', host: 'beast' } };
    const result = maskSecrets(input);
    const config = result.config as Record<string, unknown>;
    expect(config.token).toBe('abc12345...');
    expect(config.host).toBe('beast');
  });

  test('passes through non-string secret values', () => {
    const input = { apiKey: 12345, name: 'test' };
    const result = maskSecrets(input);
    expect(result.apiKey).toBe(12345);
  });
});

// --- formatLogLine ---

describe('formatLogLine', () => {
  test('produces valid JSON with ts, level, event', () => {
    const line = formatLogLine('info', 'ssh.connect_started');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ts).toBeDefined();
    expect(parsed.level).toBe(20);
    expect(parsed.event).toBe('ssh.connect_started');
  });

  test('includes fields with secrets masked', () => {
    const line = formatLogLine('error', 'auth.verify_failed', {
      host: 'beast',
      apiKey: 'sk-1234567890abcdef',
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.host).toBe('beast');
    expect(parsed.apiKey).toBe('sk-12345...');
  });

  test('works without fields', () => {
    const line = formatLogLine('warn', 'tmux.session_missing');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('tmux.session_missing');
    expect(Object.keys(parsed)).toEqual(['ts', 'level', 'event']);
  });
});

// --- DesktopLogger ---

describe('DesktopLogger', () => {
  let written: string[];
  let fileSize: number;
  let renames: { from: string; to: string }[];
  let removes: string[];
  let ensuredDirs: string[];

  function createMockFs(): LogFileSystem {
    return {
      appendFile: async (_path: string, data: string): Promise<void> => {
        written.push(data);
      },
      getFileSize: async (): Promise<number> => fileSize,
      rename: async (from: string, to: string): Promise<void> => {
        renames.push({ from, to });
      },
      remove: async (path: string): Promise<void> => {
        removes.push(path);
      },
      ensureDir: async (path: string): Promise<void> => {
        ensuredDirs.push(path);
      },
    };
  }

  beforeEach(() => {
    written = [];
    fileSize = 0;
    renames = [];
    removes = [];
    ensuredDirs = [];
  });

  test('writes structured JSON lines', async () => {
    const logger = new DesktopLogger('/tmp/test.log', createMockFs());
    await logger.info('app.start_completed', { version: '0.1.0' });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0].trim()) as Record<string, unknown>;
    expect(parsed.event).toBe('app.start_completed');
    expect(parsed.version).toBe('0.1.0');
  });

  test('respects minimum log level', async () => {
    const logger = new DesktopLogger('/tmp/test.log', createMockFs(), 'warn');
    await logger.debug('debug.event');
    await logger.info('info.event');
    await logger.warn('warn.event');
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('warn.event');
  });

  test('triggers rotation when file exceeds MAX_LOG_SIZE_BYTES', async () => {
    fileSize = MAX_LOG_SIZE_BYTES + 1;
    const logger = new DesktopLogger('/tmp/test.log', createMockFs());
    await logger.info('test.event');

    // Should have deleted .5 and renamed files
    expect(removes).toContain('/tmp/test.log.5');
    expect(renames).toContainEqual({ from: '/tmp/test.log', to: '/tmp/test.log.1' });
    expect(renames).toContainEqual({ from: '/tmp/test.log.1', to: '/tmp/test.log.2' });
  });

  test('does not rotate when file is under limit', async () => {
    fileSize = 100;
    const logger = new DesktopLogger('/tmp/test.log', createMockFs());
    await logger.info('test.event');
    expect(renames).toHaveLength(0);
    expect(removes).toHaveLength(0);
  });

  test('ensures log directory exists on first write', async () => {
    const logger = new DesktopLogger('/tmp/logs/test.log', createMockFs());
    await logger.info('test.event');
    expect(ensuredDirs).toContain('/tmp/logs');
  });

  test('ensures directory only once', async () => {
    const logger = new DesktopLogger('/tmp/logs/test.log', createMockFs());
    await logger.info('event1');
    await logger.info('event2');
    expect(ensuredDirs).toHaveLength(1);
  });

  test('getLogPath returns the configured path', () => {
    const logger = new DesktopLogger('/my/custom/path.log', createMockFs());
    expect(logger.getLogPath()).toBe('/my/custom/path.log');
  });

  test('masks secrets in log output', async () => {
    const logger = new DesktopLogger('/tmp/test.log', createMockFs());
    await logger.info('auth.check', { token: 'sk-1234567890abcdef', host: 'beast' });
    const parsed = JSON.parse(written[0].trim()) as Record<string, unknown>;
    expect(parsed.token).toBe('sk-12345...');
    expect(parsed.host).toBe('beast');
  });

  test('all log levels work', async () => {
    const logger = new DesktopLogger('/tmp/test.log', createMockFs(), 'debug');
    await logger.debug('d');
    await logger.info('i');
    await logger.warn('w');
    await logger.error('e');
    await logger.fatal('f');
    expect(written).toHaveLength(5);
  });
});
