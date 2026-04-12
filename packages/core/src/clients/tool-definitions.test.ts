import { describe, expect, test } from 'bun:test';
import {
  toolDefinitions,
  toolDefinitionsByName,
  filterToolsByName,
  excludeToolsByName,
} from './tool-definitions';
import type { ToolDefinition, JSONSchemaObject } from './tool-definitions';

const EXPECTED_TOOL_NAMES = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

describe('toolDefinitions', () => {
  test('exports all 8 canonical tools', () => {
    expect(toolDefinitions).toHaveLength(8);
    const names = toolDefinitions.map(d => d.function.name);
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  test('every definition has type "function"', () => {
    for (const def of toolDefinitions) {
      expect(def.type).toBe('function');
    }
  });

  test('every definition has name, description, and parameters', () => {
    for (const def of toolDefinitions) {
      expect(typeof def.function.name).toBe('string');
      expect(def.function.name.length).toBeGreaterThan(0);
      expect(typeof def.function.description).toBe('string');
      expect(def.function.description.length).toBeGreaterThan(0);
      expect(def.function.parameters).toBeDefined();
    }
  });

  test('every parameters object follows JSON Schema object format', () => {
    for (const def of toolDefinitions) {
      const params: JSONSchemaObject = def.function.parameters;
      expect(params.type).toBe('object');
      expect(typeof params.properties).toBe('object');
      expect(Array.isArray(params.required)).toBe(true);
      expect(params.additionalProperties).toBe(false);
    }
  });

  test('every required field exists in properties', () => {
    for (const def of toolDefinitions) {
      const params = def.function.parameters;
      for (const req of params.required) {
        expect(params.properties[req]).toBeDefined();
      }
    }
  });

  test('every property has a type and description', () => {
    for (const def of toolDefinitions) {
      const params = def.function.parameters;
      for (const [propName, prop] of Object.entries(params.properties)) {
        expect(typeof prop.type).toBe('string');
        expect(typeof prop.description).toBe('string');
        if (!prop.description) {
          throw new Error(
            `Property "${propName}" in tool "${def.function.name}" is missing a description`
          );
        }
      }
    }
  });

  test('property types are valid JSON Schema types', () => {
    const validTypes = ['string', 'integer', 'number', 'boolean', 'array', 'object'];
    for (const def of toolDefinitions) {
      for (const [propName, prop] of Object.entries(def.function.parameters.properties)) {
        expect(validTypes).toContain(prop.type);
        if (!validTypes.includes(prop.type)) {
          throw new Error(
            `Property "${propName}" in tool "${def.function.name}" has invalid type "${prop.type}"`
          );
        }
      }
    }
  });

  test('enum properties have valid enum arrays', () => {
    for (const def of toolDefinitions) {
      for (const [, prop] of Object.entries(def.function.parameters.properties)) {
        if (prop.enum !== undefined) {
          expect(Array.isArray(prop.enum)).toBe(true);
          expect(prop.enum.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('toolDefinitionsByName', () => {
  test('contains all 8 tools', () => {
    expect(toolDefinitionsByName.size).toBe(8);
  });

  test('each tool is retrievable by name', () => {
    for (const name of EXPECTED_TOOL_NAMES) {
      const def = toolDefinitionsByName.get(name);
      expect(def).toBeDefined();
      expect(def!.function.name).toBe(name);
    }
  });

  test('returns undefined for unknown tool name', () => {
    expect(toolDefinitionsByName.get('NonExistentTool')).toBeUndefined();
  });
});

describe('filterToolsByName', () => {
  test('returns only named tools', () => {
    const filtered = filterToolsByName(['Read', 'Write']);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(d => d.function.name)).toEqual(['Read', 'Write']);
  });

  test('returns empty array for no matches', () => {
    const filtered = filterToolsByName(['NonExistent']);
    expect(filtered).toHaveLength(0);
  });

  test('preserves order from original definitions', () => {
    const filtered = filterToolsByName(['Grep', 'Bash', 'Read']);
    expect(filtered.map(d => d.function.name)).toEqual(['Read', 'Bash', 'Grep']);
  });

  test('returns empty array for empty input', () => {
    const filtered = filterToolsByName([]);
    expect(filtered).toHaveLength(0);
  });
});

describe('excludeToolsByName', () => {
  test('excludes named tools', () => {
    const filtered = excludeToolsByName(['Read', 'Write']);
    expect(filtered).toHaveLength(6);
    const names = filtered.map(d => d.function.name);
    expect(names).not.toContain('Read');
    expect(names).not.toContain('Write');
  });

  test('returns all tools when no exclusions', () => {
    const filtered = excludeToolsByName([]);
    expect(filtered).toHaveLength(8);
  });

  test('returns empty when all excluded', () => {
    const filtered = excludeToolsByName(EXPECTED_TOOL_NAMES);
    expect(filtered).toHaveLength(0);
  });

  test('ignores unknown tool names in denylist', () => {
    const filtered = excludeToolsByName(['NonExistent']);
    expect(filtered).toHaveLength(8);
  });
});

describe('specific tool schemas', () => {
  test('Read has file_path required, offset/limit optional', () => {
    const def = toolDefinitionsByName.get('Read') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['file_path']);
    expect(def.function.parameters.properties.file_path.type).toBe('string');
    expect(def.function.parameters.properties.offset.type).toBe('integer');
    expect(def.function.parameters.properties.limit.type).toBe('integer');
  });

  test('Write has file_path and content required', () => {
    const def = toolDefinitionsByName.get('Write') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['file_path', 'content']);
  });

  test('Edit has file_path, old_string, new_string required', () => {
    const def = toolDefinitionsByName.get('Edit') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['file_path', 'old_string', 'new_string']);
    expect(def.function.parameters.properties.replace_all.type).toBe('boolean');
  });

  test('Bash has command required, timeout optional with limits', () => {
    const def = toolDefinitionsByName.get('Bash') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['command']);
    expect(def.function.parameters.properties.timeout.maximum).toBe(600000);
  });

  test('Glob has pattern required', () => {
    const def = toolDefinitionsByName.get('Glob') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['pattern']);
  });

  test('Grep has pattern required, output_mode enum', () => {
    const def = toolDefinitionsByName.get('Grep') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['pattern']);
    expect(def.function.parameters.properties.output_mode.enum).toEqual([
      'content',
      'files_with_matches',
      'count',
    ]);
  });

  test('WebFetch has url required', () => {
    const def = toolDefinitionsByName.get('WebFetch') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['url']);
  });

  test('WebSearch has query required', () => {
    const def = toolDefinitionsByName.get('WebSearch') as ToolDefinition;
    expect(def.function.parameters.required).toEqual(['query']);
  });
});
