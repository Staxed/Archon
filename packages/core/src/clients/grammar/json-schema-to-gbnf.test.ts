import { describe, expect, test } from 'bun:test';
import { jsonSchemaToGbnf, GbnfUnsupportedError } from './json-schema-to-gbnf';

describe('jsonSchemaToGbnf', () => {
  test('translates simple string type', () => {
    const grammar = jsonSchemaToGbnf({ type: 'string' });
    expect(grammar).toContain('root ::= string');
    expect(grammar).toContain('string ::=');
  });

  test('translates number type', () => {
    const grammar = jsonSchemaToGbnf({ type: 'number' });
    expect(grammar).toContain('root ::= number');
    expect(grammar).toContain('number ::=');
  });

  test('translates integer type', () => {
    const grammar = jsonSchemaToGbnf({ type: 'integer' });
    expect(grammar).toContain('root ::= integer');
    expect(grammar).toContain('integer ::=');
  });

  test('translates boolean type', () => {
    const grammar = jsonSchemaToGbnf({ type: 'boolean' });
    expect(grammar).toContain('root ::= boolean');
    expect(grammar).toContain('boolean ::= "true" | "false"');
  });

  test('translates null type', () => {
    const grammar = jsonSchemaToGbnf({ type: 'null' });
    expect(grammar).toContain('root ::= null');
    expect(grammar).toContain('null ::= "null"');
  });

  test('translates string enum', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
    expect(grammar).toContain('root ::= root-enum');
    expect(grammar).toContain('root-enum ::=');
    expect(grammar).toContain('"red"');
    expect(grammar).toContain('"green"');
    expect(grammar).toContain('"blue"');
  });

  test('translates number enum', () => {
    const grammar = jsonSchemaToGbnf({
      enum: [1, 2, 3],
    });
    expect(grammar).toContain('"1"');
    expect(grammar).toContain('"2"');
    expect(grammar).toContain('"3"');
  });

  test('translates simple object with required fields', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    });
    expect(grammar).toContain('root ::= "{" ws');
    expect(grammar).toContain('\\"name\\"');
    expect(grammar).toContain('\\"age\\"');
    expect(grammar).toContain('string');
    expect(grammar).toContain('number');
  });

  test('translates object with optional fields (all emitted)', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
      },
    });
    // Both fields should be present even without required
    expect(grammar).toContain('\\"title\\"');
    expect(grammar).toContain('\\"count\\"');
  });

  test('translates nested objects', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            active: { type: 'boolean' },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    });
    expect(grammar).toContain('\\"user\\"');
    expect(grammar).toContain('\\"name\\"');
    expect(grammar).toContain('\\"active\\"');
  });

  test('translates array of primitives', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'array',
      items: { type: 'string' },
    });
    expect(grammar).toContain('root ::= "[" ws');
    expect(grammar).toContain('string');
    expect(grammar).toContain('"," ws');
  });

  test('translates array of objects', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          label: { type: 'string' },
        },
        required: ['id'],
      },
    });
    expect(grammar).toContain('"[" ws');
    expect(grammar).toContain('\\"id\\"');
    expect(grammar).toContain('\\"label\\"');
  });

  test('translates object without explicit type but with properties', () => {
    const grammar = jsonSchemaToGbnf({
      properties: {
        x: { type: 'number' },
      },
    });
    expect(grammar).toContain('"{" ws');
    expect(grammar).toContain('\\"x\\"');
  });

  test('translates empty object', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {},
    });
    expect(grammar).toContain('root ::= "{" ws "}"');
  });

  test('handles property names with special characters', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {
        'my-field': { type: 'string' },
        my_other: { type: 'number' },
      },
    });
    expect(grammar).toContain('my-field');
    expect(grammar).toContain('my_other');
  });

  test('handles boolean enum values', () => {
    const grammar = jsonSchemaToGbnf({
      enum: [true, false],
    });
    expect(grammar).toContain('"true"');
    expect(grammar).toContain('"false"');
  });

  // Unsupported features
  test('throws on $ref', () => {
    expect(() => jsonSchemaToGbnf({ $ref: '#/definitions/Foo' })).toThrow(GbnfUnsupportedError);
  });

  test('throws on oneOf', () => {
    expect(() => jsonSchemaToGbnf({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toThrow(
      GbnfUnsupportedError
    );
  });

  test('throws on anyOf', () => {
    expect(() => jsonSchemaToGbnf({ anyOf: [{ type: 'string' }] })).toThrow(GbnfUnsupportedError);
  });

  test('throws on allOf', () => {
    expect(() => jsonSchemaToGbnf({ allOf: [{ type: 'string' }] })).toThrow(GbnfUnsupportedError);
  });

  test('throws on not', () => {
    expect(() => jsonSchemaToGbnf({ not: { type: 'string' } })).toThrow(GbnfUnsupportedError);
  });

  test('throws on if/then/else', () => {
    expect(() => jsonSchemaToGbnf({ if: { type: 'string' }, then: {}, else: {} })).toThrow(
      GbnfUnsupportedError
    );
  });

  test('throws on patternProperties', () => {
    expect(() => jsonSchemaToGbnf({ patternProperties: {} })).toThrow(GbnfUnsupportedError);
  });

  test('throws on array without items', () => {
    expect(() => jsonSchemaToGbnf({ type: 'array' })).toThrow(GbnfUnsupportedError);
  });

  test('throws on missing type without properties', () => {
    expect(() => jsonSchemaToGbnf({})).toThrow(GbnfUnsupportedError);
  });

  test('throws on unknown type', () => {
    expect(() => jsonSchemaToGbnf({ type: 'custom' })).toThrow(GbnfUnsupportedError);
  });

  test('throws on nested unsupported features', () => {
    expect(() =>
      jsonSchemaToGbnf({
        type: 'object',
        properties: {
          field: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      })
    ).toThrow(GbnfUnsupportedError);
  });

  // Round-trip: grammar should be syntactically valid GBNF
  test('produced grammar has correct GBNF structure', () => {
    const grammar = jsonSchemaToGbnf({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        status: { enum: ['active', 'inactive'] },
        metadata: {
          type: 'object',
          properties: {
            created: { type: 'number' },
            valid: { type: 'boolean' },
          },
        },
      },
      required: ['name', 'age'],
    });

    // Each line should be either a rule (name ::= expr) or blank
    const lines = grammar.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      expect(trimmed).toMatch(/^[a-zA-Z][a-zA-Z0-9-]* ::= .+$/);
    }

    // Must start with root rule
    expect(lines[0].trim()).toMatch(/^root ::= /);

    // Must contain primitive definitions
    expect(grammar).toContain('ws ::=');
    expect(grammar).toContain('string ::=');
    expect(grammar).toContain('number ::=');
    expect(grammar).toContain('integer ::=');
    expect(grammar).toContain('boolean ::=');
  });
});
