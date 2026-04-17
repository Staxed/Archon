import { describe, test, expect } from 'bun:test';
import { knowledgeExtractNodeSchema } from './dag-node';

describe('knowledgeExtractNodeSchema', () => {
  const baseNode = {
    id: 'extract-node',
    knowledge_extract: 'Extract patterns from the conversation',
  };

  test('accepts node without scope (defaults to both)', () => {
    const result = knowledgeExtractNodeSchema.safeParse(baseNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('both');
    }
  });

  test('accepts scope=project', () => {
    const result = knowledgeExtractNodeSchema.safeParse({ ...baseNode, scope: 'project' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('project');
    }
  });

  test('accepts scope=global', () => {
    const result = knowledgeExtractNodeSchema.safeParse({ ...baseNode, scope: 'global' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('global');
    }
  });

  test('accepts scope=both', () => {
    const result = knowledgeExtractNodeSchema.safeParse({ ...baseNode, scope: 'both' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('both');
    }
  });

  test('rejects invalid scope value', () => {
    const result = knowledgeExtractNodeSchema.safeParse({ ...baseNode, scope: 'invalid' });
    expect(result.success).toBe(false);
  });

  test('rejects empty knowledge_extract prompt', () => {
    const result = knowledgeExtractNodeSchema.safeParse({ id: 'node', knowledge_extract: '' });
    expect(result.success).toBe(false);
  });
});
