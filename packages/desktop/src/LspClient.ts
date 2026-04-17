/**
 * LSP client helper for the desktop editor.
 * Resolves language server WebSocket URIs and manages connection state.
 * Uses `codemirror-languageserver` for CM6 integration.
 */

/** Languages supported by the LSP proxy endpoint on the server. */
export const SUPPORTED_LSP_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'markdown',
] as const;

export type LspLanguage = (typeof SUPPORTED_LSP_LANGUAGES)[number];

/**
 * Check whether a language (as returned by extensionToLanguage) is LSP-supported.
 */
export function isLspSupported(language: string | null): language is LspLanguage {
  if (!language) return false;
  return (SUPPORTED_LSP_LANGUAGES as readonly string[]).includes(language);
}

/**
 * Map a file extension to an LSP language identifier.
 * Returns null for unsupported extensions.
 */
export function fileExtToLspLanguage(ext: string): LspLanguage | null {
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'md':
    case 'mdx':
      return 'markdown';
    default:
      return null;
  }
}

/**
 * Build the WebSocket URI for connecting to the LSP proxy.
 * @param serverBaseUrl - The base URL of the Archon server (e.g. "http://localhost:3090")
 * @param language - LSP language identifier
 * @param projectDir - Absolute path to the project directory on the remote host
 */
export function buildLspWsUri(serverBaseUrl: string, language: string, projectDir: string): string {
  // Convert http(s) → ws(s)
  const wsBase = serverBaseUrl.replace(/^http/, 'ws');
  const params = new URLSearchParams({ language, projectDir });
  return `${wsBase}/api/desktop/lsp?${params.toString()}`;
}

/**
 * Derive the project directory from a file path by walking up to the first
 * directory that likely contains a project root marker.
 * For simplicity in v1, we use the directory of the file itself.
 * A smarter heuristic could look for package.json, Cargo.toml, go.mod, etc.
 */
export function deriveProjectDir(filePath: string): string {
  // Use the parent directory of the file
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return filePath.substring(0, lastSlash);
}

/**
 * Extract the file extension from a path.
 */
export function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');
  if (lastDot <= 0 || lastDot < lastSlash) return '';
  return path.substring(lastDot + 1);
}
