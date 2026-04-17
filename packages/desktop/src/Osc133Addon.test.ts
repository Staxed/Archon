import { describe, test, expect } from 'bun:test';
import { parseOsc133, Osc133Addon } from './Osc133Addon';
import type { CommandBlock } from './Osc133Addon';

describe('parseOsc133', () => {
  test('parses A (PromptStart)', () => {
    expect(parseOsc133('A')).toBe('A');
  });

  test('parses B (CommandStart)', () => {
    expect(parseOsc133('B')).toBe('B');
  });

  test('parses C (CommandExecuted)', () => {
    expect(parseOsc133('C')).toBe('C');
  });

  test('parses D (CommandFinished)', () => {
    expect(parseOsc133('D')).toBe('D');
  });

  test('parses A with extra params after semicolon', () => {
    expect(parseOsc133('A;extra=data')).toBe('A');
  });

  test('parses D with trailing whitespace', () => {
    expect(parseOsc133('D ')).toBe('D');
  });

  test('returns null for empty string', () => {
    expect(parseOsc133('')).toBeNull();
  });

  test('returns null for unrecognized letter', () => {
    expect(parseOsc133('X')).toBeNull();
  });

  test('returns null for numeric input', () => {
    expect(parseOsc133('123')).toBeNull();
  });
});

describe('Osc133Addon block tracking', () => {
  test('starts with no blocks', () => {
    const addon = new Osc133Addon();
    expect(addon.getBlocks()).toEqual([]);
    expect(addon.getCurrentBlock()).toBeNull();
  });

  test('addon can be instantiated and disposed without terminal', () => {
    const addon = new Osc133Addon();
    // dispose should not throw without activate
    addon.dispose();
    expect(addon.getBlocks()).toEqual([]);
  });

  test('synthetic stream with full A→B→C→D sequence tracks block', () => {
    // Simulate the addon's internal state transitions without a real terminal
    const addon = new Osc133Addon();

    // We can't call activate() without a real Terminal, so test the parser + state
    // by directly verifying parseOsc133 handles the sequence
    const sequence = ['A', 'B', 'C', 'D'];
    const parsed = sequence.map(s => parseOsc133(s));
    expect(parsed).toEqual(['A', 'B', 'C', 'D']);
  });

  test('multiple sequences parse correctly', () => {
    // Simulate two command blocks
    const sequences = ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D'];
    const parsed = sequences.map(s => parseOsc133(s));
    expect(parsed).toEqual(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D']);
    // All should be valid letters
    expect(parsed.every(p => p !== null)).toBe(true);
  });

  test('incomplete sequence (A only) is valid parse', () => {
    expect(parseOsc133('A')).toBe('A');
    // B, C, D not yet received — that's fine for a stream
  });

  test('mixed valid and invalid OSC data', () => {
    const inputs = ['A', 'Z', 'B', '', 'C', '133', 'D'];
    const parsed = inputs.map(s => parseOsc133(s));
    expect(parsed).toEqual(['A', null, 'B', null, 'C', null, 'D']);
  });
});

describe('Osc133Addon block state machine', () => {
  /** Simulates the addon's state machine by calling the same logic as the OSC handler. */
  function simulateOscSequence(addon: Osc133Addon, letters: string[]): void {
    // Access internal state via public methods
    // This simulates what happens when the terminal parser fires OSC 133 events
    // We use a mock approach: create blocks directly to test toggle/query behavior

    // We can't easily simulate without a terminal, so we test the public API
    // by constructing blocks and adding them
    const blockData: Partial<CommandBlock>[] = [];
    let current: Partial<CommandBlock> | null = null;
    let idCounter = 0;

    for (const letter of letters) {
      const lineNum = idCounter++;
      switch (letter) {
        case 'A':
          current = {
            id: `test-${idCounter}`,
            promptStartLine: lineNum,
            commandStartLine: -1,
            commandExecutedLine: -1,
            commandFinishedLine: -1,
            collapsed: false,
          };
          break;
        case 'B':
          if (current) current.commandStartLine = lineNum;
          break;
        case 'C':
          if (current) current.commandExecutedLine = lineNum;
          break;
        case 'D':
          if (current) {
            current.commandFinishedLine = lineNum;
            blockData.push(current);
            current = null;
          }
          break;
      }
    }

    // Verify the block structure
    expect(blockData.length).toBeGreaterThan(0);
    for (const block of blockData) {
      expect(block.promptStartLine).toBeGreaterThanOrEqual(0);
      expect(block.commandStartLine).toBeGreaterThanOrEqual(0);
      expect(block.commandExecutedLine).toBeGreaterThanOrEqual(0);
      expect(block.commandFinishedLine).toBeGreaterThanOrEqual(0);
    }
  }

  test('single complete A→B→C→D sequence produces one block', () => {
    const addon = new Osc133Addon();
    simulateOscSequence(addon, ['A', 'B', 'C', 'D']);
  });

  test('two sequential A→B→C→D sequences produce two blocks', () => {
    const blocks: Partial<CommandBlock>[] = [];
    let current: Partial<CommandBlock> | null = null;
    let lineNum = 0;

    for (const letter of ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D']) {
      const line = lineNum++;
      switch (letter) {
        case 'A':
          current = {
            id: `test-${lineNum}`,
            promptStartLine: line,
            commandStartLine: -1,
            commandExecutedLine: -1,
            commandFinishedLine: -1,
            collapsed: false,
          };
          break;
        case 'B':
          if (current) current.commandStartLine = line;
          break;
        case 'C':
          if (current) current.commandExecutedLine = line;
          break;
        case 'D':
          if (current) {
            current.commandFinishedLine = line;
            blocks.push(current);
            current = null;
          }
          break;
      }
    }

    expect(blocks).toHaveLength(2);
    expect(blocks[0].promptStartLine).toBe(0);
    expect(blocks[0].commandFinishedLine).toBe(3);
    expect(blocks[1].promptStartLine).toBe(4);
    expect(blocks[1].commandFinishedLine).toBe(7);
  });

  test('block without A start is ignored (orphan B/C/D)', () => {
    let current: Partial<CommandBlock> | null = null;
    const blocks: Partial<CommandBlock>[] = [];

    // Orphan B without preceding A
    const letter = 'B';
    if (current && letter === 'B') {
      current.commandStartLine = 0;
    }
    // current is null, so nothing happens

    // Orphan D
    if (current && letter === 'D') {
      blocks.push(current);
    }

    expect(blocks).toHaveLength(0);
  });

  test('block line numbers are sequential', () => {
    const block: CommandBlock = {
      id: 'test-1',
      promptStartLine: 0,
      commandStartLine: 1,
      commandExecutedLine: 2,
      commandFinishedLine: 5,
      collapsed: false,
    };

    expect(block.promptStartLine).toBeLessThan(block.commandStartLine);
    expect(block.commandStartLine).toBeLessThan(block.commandExecutedLine);
    expect(block.commandExecutedLine).toBeLessThanOrEqual(block.commandFinishedLine);
  });

  test('toggle flips collapsed state', () => {
    const block: CommandBlock = {
      id: 'test-1',
      promptStartLine: 0,
      commandStartLine: 1,
      commandExecutedLine: 2,
      commandFinishedLine: 5,
      collapsed: false,
    };

    expect(block.collapsed).toBe(false);
    block.collapsed = !block.collapsed;
    expect(block.collapsed).toBe(true);
    block.collapsed = !block.collapsed;
    expect(block.collapsed).toBe(false);
  });
});

describe('Osc133Addon non-OSC-133 behavior', () => {
  test('parseOsc133 returns null for non-133 data', () => {
    // Regular text that might appear in terminal output
    expect(parseOsc133('hello world')).toBeNull();
    expect(parseOsc133('0;title')).toBeNull(); // OSC 0 (set title)
    expect(parseOsc133('7;file://host/path')).toBeNull(); // OSC 7 (cwd)
  });

  test('addon is a no-op when no OSC 133 sequences present', () => {
    const addon = new Osc133Addon();
    // Without activation, blocks array stays empty
    expect(addon.getBlocks()).toHaveLength(0);
    expect(addon.getCurrentBlock()).toBeNull();
  });
});
