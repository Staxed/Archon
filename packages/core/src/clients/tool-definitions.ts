/**
 * Canonical tool definitions in OpenAI function-call JSON Schema format.
 *
 * These definitions are consumed by the agentic tool-execution loop and
 * provider clients that speak the OpenAI-compatible chat/completions protocol.
 * The tool surface mirrors the Claude Agent SDK's built-in tools.
 */

/** JSON Schema type subset used in tool parameter definitions. */
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: readonly string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  items?: JSONSchemaProperty;
}

/** JSON Schema object used for tool `parameters`. */
export interface JSONSchemaObject {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required: readonly string[];
  additionalProperties?: boolean;
}

/** A single tool definition in OpenAI function-call format. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchemaObject;
  };
}

/**
 * Canonical tool definitions array.
 *
 * Each entry mirrors a Claude Agent SDK tool with matching parameter semantics.
 */
export const toolDefinitions: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a file from the filesystem. Returns file content with line numbers. ' +
        'Use offset and limit to read specific portions of large files.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to read.',
          },
          offset: {
            type: 'integer',
            description:
              'The line number to start reading from (0-based). Only provide if the file is too large to read at once.',
            minimum: 0,
          },
          limit: {
            type: 'integer',
            description:
              'The number of lines to read. Only provide if the file is too large to read at once.',
            exclusiveMinimum: 0,
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Write content to a file. Creates the file if it does not exist, or overwrites the existing file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to write.',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file.',
          },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Perform an exact string replacement in a file. The old_string must appear exactly once in the file. ' +
        'Use replace_all to replace every occurrence.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to modify.',
          },
          old_string: {
            type: 'string',
            description:
              'The text to replace. Must be unique in the file unless replace_all is true.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences of old_string (default false).',
            default: false,
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Execute a shell command and return its output (stdout and stderr). ' +
        'Commands run in a bash shell with the working directory set to the provided cwd.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute.',
          },
          timeout: {
            type: 'integer',
            description: 'Optional timeout in milliseconds (default 120000, max 600000).',
            minimum: 1,
            maximum: 600000,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description:
        'Find files matching a glob pattern. Returns matching file paths sorted by modification time.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'The glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx").',
          },
          path: {
            type: 'string',
            description: 'The directory to search in. Defaults to cwd if not specified.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description:
        'Search file contents using a regular expression pattern. Returns matching lines or file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The regular expression pattern to search for.',
          },
          path: {
            type: 'string',
            description: 'File or directory to search in. Defaults to cwd.',
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts", "*.{ts,tsx}").',
          },
          type: {
            type: 'string',
            description: 'File type filter (e.g., "ts", "py", "js").',
          },
          output_mode: {
            type: 'string',
            description:
              'Output mode: "content" for matching lines, "files_with_matches" for file paths only, "count" for match counts.',
            enum: ['content', 'files_with_matches', 'count'],
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case insensitive search.',
            default: false,
          },
          context_lines: {
            type: 'integer',
            description: 'Number of context lines to show before and after each match.',
            minimum: 0,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Fetch content from a URL. Returns the response body as text or JSON.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
          timeout: {
            type: 'integer',
            description: 'Request timeout in milliseconds (default 30000).',
            minimum: 1,
            maximum: 300000,
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description:
        'Perform a web search and return results. Requires a search API key to be configured.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query string.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of results to return (default 5).',
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
] as const;

/** Lookup map from tool name to its definition. */
export const toolDefinitionsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  toolDefinitions.map(def => [def.function.name, def])
);

/**
 * Filter tool definitions by an allowlist of tool names.
 * Returns only the definitions whose names appear in the provided list.
 */
export function filterToolsByName(names: readonly string[]): ToolDefinition[] {
  const nameSet = new Set(names);
  return toolDefinitions.filter(def => nameSet.has(def.function.name));
}

/**
 * Exclude tool definitions by a denylist of tool names.
 * Returns definitions whose names do NOT appear in the provided list.
 */
export function excludeToolsByName(names: readonly string[]): ToolDefinition[] {
  const nameSet = new Set(names);
  return toolDefinitions.filter(def => !nameSet.has(def.function.name));
}
