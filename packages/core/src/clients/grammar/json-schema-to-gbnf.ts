/**
 * Translates a JSON Schema (subset) to GBNF grammar format for llama.cpp.
 *
 * Supported JSON Schema features:
 * - type: object, string, number, integer, boolean, null
 * - enum (string and number values)
 * - array (items as primitives or objects)
 * - required fields
 * - nested objects
 * - properties
 *
 * Unsupported features throw GbnfUnsupportedError.
 */

/** Error thrown when a JSON Schema feature is not supported by the GBNF translator. */
export class GbnfUnsupportedError extends Error {
  constructor(feature: string) {
    super(`Unsupported JSON Schema feature for GBNF translation: ${feature}`);
    this.name = 'GbnfUnsupportedError';
  }
}

/**
 * Primitive GBNF rules appended to all generated grammars.
 *
 * These rules define the terminal symbols for JSON values per RFC 8259:
 * - `ws`: Optional whitespace (space, tab, newline)
 * - `string`: JSON string with escape sequences (\", \\, \/, \b, \f, \n, \r, \t, \uXXXX)
 * - `number`: JSON number with optional sign, decimal, and exponent
 * - `integer`: JSON integer (no decimal or exponent)
 * - `boolean`: Literal "true" or "false"
 * - `null`: Literal "null"
 *
 * @see https://github.com/ggerganov/llama.cpp/blob/master/grammars/README.md
 */
const PRIMITIVE_RULES = `
ws ::= [ \\t\\n]*
string ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])* "\\""
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
integer ::= "-"? ("0" | [1-9] [0-9]*)
boolean ::= "true" | "false"
null ::= "null"
`.trim();

interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: (string | number | boolean)[];
  // Additional fields that signal unsupported features
  oneOf?: unknown;
  anyOf?: unknown;
  allOf?: unknown;
  $ref?: string;
  not?: unknown;
  if?: unknown;
  then?: unknown;
  else?: unknown;
  patternProperties?: unknown;
  additionalProperties?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/**
 * Translates a JSON Schema object to a GBNF grammar string.
 *
 * @param schema - A JSON Schema object (subset supported)
 * @returns A GBNF grammar string suitable for llama.cpp's `grammar` field
 * @throws GbnfUnsupportedError if the schema uses unsupported features
 */
export function jsonSchemaToGbnf(schema: Record<string, unknown>): string {
  const s = schema as SchemaObject;
  const rules: string[] = [];
  const ruleNames = new Set<string>();

  // Check for unsupported top-level features
  checkUnsupportedFeatures(s, 'root');

  // Generate the root rule
  const rootExpr = generateRule(s, 'root', rules, ruleNames);
  const rootRule = `root ::= ${rootExpr}`;

  // Combine: root rule first, then generated rules, then primitives
  const allRules = [rootRule, ...rules, PRIMITIVE_RULES].join('\n');
  return allRules;
}

/** Throw GbnfUnsupportedError if the schema uses features outside our supported subset. */
function checkUnsupportedFeatures(s: SchemaObject, context: string): void {
  if (s.$ref !== undefined) {
    throw new GbnfUnsupportedError(`$ref at ${context}`);
  }
  if (s.oneOf !== undefined) {
    throw new GbnfUnsupportedError(`oneOf at ${context}`);
  }
  if (s.anyOf !== undefined) {
    throw new GbnfUnsupportedError(`anyOf at ${context}`);
  }
  if (s.allOf !== undefined) {
    throw new GbnfUnsupportedError(`allOf at ${context}`);
  }
  if (s.not !== undefined) {
    throw new GbnfUnsupportedError(`not at ${context}`);
  }
  if (s.if !== undefined) {
    throw new GbnfUnsupportedError(`if/then/else at ${context}`);
  }
  if (s.patternProperties !== undefined) {
    throw new GbnfUnsupportedError(`patternProperties at ${context}`);
  }
}

/** Generate a GBNF rule expression for a given schema node, recursively creating sub-rules as needed. */
function generateRule(
  s: SchemaObject,
  name: string,
  rules: string[],
  ruleNames: Set<string>
): string {
  // Handle enum first (can appear with or without type)
  if (s.enum !== undefined) {
    return generateEnumRule(s.enum, name, rules, ruleNames);
  }

  const type = s.type;
  if (type === undefined) {
    // No type specified — if properties exist, treat as object
    if (s.properties !== undefined) {
      return generateObjectRule(s, name, rules, ruleNames);
    }
    throw new GbnfUnsupportedError(`missing "type" at ${name}`);
  }

  switch (type) {
    case 'object':
      return generateObjectRule(s, name, rules, ruleNames);
    case 'array':
      return generateArrayRule(s, name, rules, ruleNames);
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      throw new GbnfUnsupportedError(`type "${type}" at ${name}`);
  }
}

/** Generate a GBNF rule for an enum: each value becomes an alternative in the rule. */
function generateEnumRule(
  values: (string | number | boolean)[],
  name: string,
  rules: string[],
  ruleNames: Set<string>
): string {
  const alternatives = values.map(v => {
    if (typeof v === 'string') {
      return `"\\"" "${escapeGbnfString(v)}" "\\""`;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      return `"${String(v)}"`;
    }
    throw new GbnfUnsupportedError(`enum value of type ${typeof v} at ${name}`);
  });

  const ruleName = uniqueRuleName(name + '-enum', ruleNames);
  rules.push(`${ruleName} ::= ${alternatives.join(' | ')}`);
  return ruleName;
}

/** Generate a GBNF rule for an object type: emits key-value pairs for all properties. */
function generateObjectRule(
  s: SchemaObject,
  name: string,
  rules: string[],
  ruleNames: Set<string>
): string {
  const properties = s.properties;
  if (properties === undefined || Object.keys(properties).length === 0) {
    // Empty object: just match {}
    return '"{" ws "}"';
  }

  const propNames = Object.keys(properties);

  // Build property rules
  // GBNF doesn't natively support optional object keys, so all properties
  // are emitted as required. Models filling JSON schemas tend to include all fields.
  const propParts: string[] = [];
  for (const propName of propNames) {
    const propSchema = properties[propName];
    checkUnsupportedFeatures(propSchema, `${name}.${propName}`);

    const propRuleName = uniqueRuleName(`${name}-${sanitizeRuleName(propName)}`, ruleNames);
    const valueExpr = generateRule(propSchema, propRuleName, rules, ruleNames);
    const keyValue = `"\\"${escapeGbnfString(propName)}\\"" ws ":" ws ${valueExpr}`;
    propParts.push(keyValue);
  }

  // Join properties with comma separators
  if (propParts.length === 0) {
    return '"{" ws "}"';
  }

  const joined = propParts.join(' ws "," ws ');
  return `"{" ws ${joined} ws "}"`;
}

/** Generate a GBNF rule for an array type: matches `[]` or `[item, item, ...]`. */
function generateArrayRule(
  s: SchemaObject,
  name: string,
  rules: string[],
  ruleNames: Set<string>
): string {
  const items = s.items;
  if (items === undefined) {
    throw new GbnfUnsupportedError(`array without "items" at ${name}`);
  }

  checkUnsupportedFeatures(items, `${name}.items`);

  const itemRuleName = uniqueRuleName(`${name}-item`, ruleNames);
  const itemExpr = generateRule(items, itemRuleName, rules, ruleNames);

  // Array: [] or [item, item, ...]
  const itemRule = uniqueRuleName(`${name}-items`, ruleNames);
  rules.push(`${itemRule} ::= ${itemExpr} (ws "," ws ${itemExpr})*`);

  return `"[" ws (${itemRule})? ws "]"`;
}

/** Escape special characters in a string for use inside a GBNF quoted literal. */
function escapeGbnfString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Replace non-alphanumeric chars with hyphens for use as a GBNF rule name. */
function sanitizeRuleName(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-');
}

/** Generate a unique GBNF rule name by appending a numeric suffix if the base name is taken. */
function uniqueRuleName(base: string, existing: Set<string>): string {
  let name = base;
  let counter = 0;
  while (existing.has(name)) {
    counter++;
    name = `${base}${counter}`;
  }
  existing.add(name);
  return name;
}
