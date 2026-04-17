/**
 * Minimal structured logger for Archon Desktop.
 *
 * Writes structured JSON lines to per-OS log paths with 10 MB rotation.
 * Does NOT use Pino — implements rotation in-house per PRD §10.10.
 * Event naming follows CLAUDE.md convention: `domain.action_state`.
 */

/** Maximum log file size in bytes (10 MB) */
export const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum number of rotated files to keep (.1 through .5) */
export const MAX_ROTATED_FILES = 5;

/** Log file name */
export const LOG_FILENAME = 'archon-desktop.log';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export type Platform = 'win32' | 'darwin' | 'linux';

/**
 * Get the log directory path for the given platform.
 *
 * - Windows: %APPDATA%\ArchonDesktop\logs\
 * - macOS:   ~/Library/Logs/ArchonDesktop/
 * - Linux:   ~/.local/share/ArchonDesktop/logs/ (fallback)
 */
export function getLogDir(platform: Platform, homeDir: string, appDataDir?: string): string {
  switch (platform) {
    case 'win32':
      // %APPDATA%\ArchonDesktop\logs
      return `${appDataDir ?? `${homeDir}\\AppData\\Roaming`}\\ArchonDesktop\\logs`;
    case 'darwin':
      // ~/Library/Logs/ArchonDesktop
      return `${homeDir}/Library/Logs/ArchonDesktop`;
    case 'linux':
      return `${homeDir}/.local/share/ArchonDesktop/logs`;
  }
}

/**
 * Get the full log file path for the given platform.
 */
export function getLogPath(platform: Platform, homeDir: string, appDataDir?: string): string {
  const dir = getLogDir(platform, homeDir, appDataDir);
  const sep = platform === 'win32' ? '\\' : '/';
  return `${dir}${sep}${LOG_FILENAME}`;
}

/**
 * Get the path for a rotated log file (.1, .2, etc.).
 */
export function getRotatedPath(logPath: string, index: number): string {
  return `${logPath}.${index}`;
}

/**
 * Compute the rotation plan: which files to rename/delete.
 * Returns an ordered list of operations to perform.
 */
export function computeRotationPlan(
  logPath: string,
  maxFiles: number = MAX_ROTATED_FILES
): { from: string; to: string | null }[] {
  const ops: { from: string; to: string | null }[] = [];

  // Delete the oldest (.maxFiles) if it exists
  ops.push({ from: getRotatedPath(logPath, maxFiles), to: null });

  // Shift .N → .N+1, from maxFiles-1 down to 1
  for (let i = maxFiles - 1; i >= 1; i--) {
    ops.push({ from: getRotatedPath(logPath, i), to: getRotatedPath(logPath, i + 1) });
  }

  // Current → .1
  ops.push({ from: logPath, to: getRotatedPath(logPath, 1) });

  return ops;
}

/** Fields that should be masked in log output */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /secret/i,
  /credential/i,
  /authorization/i,
];

/**
 * Mask a string value that looks like a secret.
 * Shows first 8 chars followed by '...'
 */
export function maskValue(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 8)}...`;
}

/**
 * Check if a key name looks like it contains a secret.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(key));
}

/**
 * Deep-clone an object, masking any values whose keys match secret patterns.
 * Returns a new object safe for logging.
 */
export function maskSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key) && typeof value === 'string') {
      result[key] = maskValue(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Format a single log line as a JSON string.
 *
 * Matches @archon/paths Pino convention:
 * { ts, level, event, ...fields }
 */
export function formatLogLine(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: LEVEL_VALUES[level],
    event,
  };
  if (fields) {
    const masked = maskSecrets(fields);
    Object.assign(entry, masked);
  }
  return JSON.stringify(entry);
}

/**
 * File system interface for the logger.
 * Allows injection of Tauri fs or Node fs or mock for testing.
 */
export interface LogFileSystem {
  /** Append text to a file, creating it if needed. */
  appendFile(path: string, data: string): Promise<void>;
  /** Get the size of a file in bytes. Returns 0 if file doesn't exist. */
  getFileSize(path: string): Promise<number>;
  /** Rename a file. No-op if source doesn't exist. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file. No-op if file doesn't exist. */
  remove(path: string): Promise<void>;
  /** Ensure directory exists (recursive mkdir). */
  ensureDir(path: string): Promise<void>;
}

/**
 * Minimal desktop logger with structured JSON output and rotation.
 */
export class DesktopLogger {
  private readonly logPath: string;
  private readonly fs: LogFileSystem;
  private readonly minLevel: LogLevel;
  private initialized = false;

  constructor(logPath: string, fs: LogFileSystem, minLevel: LogLevel = 'info') {
    this.logPath = logPath;
    this.fs = fs;
    this.minLevel = minLevel;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const sep = this.logPath.includes('\\') ? '\\' : '/';
    const dir = this.logPath.slice(0, this.logPath.lastIndexOf(sep));
    await this.fs.ensureDir(dir);
    this.initialized = true;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_VALUES[level] >= LEVEL_VALUES[this.minLevel];
  }

  private async rotateIfNeeded(): Promise<void> {
    const size = await this.fs.getFileSize(this.logPath);
    if (size < MAX_LOG_SIZE_BYTES) return;

    const plan = computeRotationPlan(this.logPath);
    for (const op of plan) {
      if (op.to === null) {
        await this.fs.remove(op.from);
      } else {
        await this.fs.rename(op.from, op.to);
      }
    }
  }

  async log(level: LogLevel, event: string, fields?: Record<string, unknown>): Promise<void> {
    if (!this.shouldLog(level)) return;
    await this.ensureInitialized();
    await this.rotateIfNeeded();
    const line = formatLogLine(level, event, fields);
    await this.fs.appendFile(this.logPath, line + '\n');
  }

  async debug(event: string, fields?: Record<string, unknown>): Promise<void> {
    return this.log('debug', event, fields);
  }

  async info(event: string, fields?: Record<string, unknown>): Promise<void> {
    return this.log('info', event, fields);
  }

  async warn(event: string, fields?: Record<string, unknown>): Promise<void> {
    return this.log('warn', event, fields);
  }

  async error(event: string, fields?: Record<string, unknown>): Promise<void> {
    return this.log('error', event, fields);
  }

  async fatal(event: string, fields?: Record<string, unknown>): Promise<void> {
    return this.log('fatal', event, fields);
  }

  /** Return the log file path (for Settings → About → Open Logs). */
  getLogPath(): string {
    return this.logPath;
  }
}
