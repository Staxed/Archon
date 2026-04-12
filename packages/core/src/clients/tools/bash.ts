import { execFileAsync } from '@archon/git';

const DEFAULT_TIMEOUT_MS = 120_000; // 120 seconds
const MAX_TIMEOUT_MS = 600_000; // 600 seconds
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB truncation limit
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB max buffer for execFileAsync

/**
 * Execute a shell command via bash within the working directory.
 * Uses execFileAsync from @archon/git (never raw exec).
 * Enforces timeout (default 120s, max 600s).
 */
export async function bashTool(params: Record<string, unknown>, cwd: string): Promise<string> {
  const command = params.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('Bash: command is required and must be a non-empty string.');
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof params.timeout === 'number') {
    timeoutMs = Math.min(Math.max(1, Math.floor(params.timeout)), MAX_TIMEOUT_MS);
  }

  try {
    const result = await execFileAsync('bash', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });

    let output = '';
    if (result.stdout.length > 0) {
      output += result.stdout;
    }
    if (result.stderr.length > 0) {
      if (output.length > 0) output += '\n';
      output += `[stderr]\n${result.stderr}`;
    }

    if (output.length === 0) {
      return '(command completed with no output)';
    }

    if (output.length > MAX_OUTPUT_BYTES) {
      output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
    }

    return output;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    if (error.killed || error.code === 'ERR_CHILD_PROCESS_TIMEOUT') {
      throw new Error(
        `Bash: Command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 100)}`
      );
    }

    // For non-zero exit codes, execFileAsync throws but may have stdout/stderr
    let output = '';
    if (error.stdout && error.stdout.length > 0) {
      output += error.stdout;
    }
    if (error.stderr && error.stderr.length > 0) {
      if (output.length > 0) output += '\n';
      output += `[stderr]\n${error.stderr}`;
    }

    if (output.length > 0) {
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
      }
      return `[exit code: non-zero]\n${output}`;
    }

    throw new Error(`Bash: Command failed: ${error.message}`);
  }
}
