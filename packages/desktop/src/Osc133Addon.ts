import type { Terminal, ITerminalAddon, IDisposable } from '@xterm/xterm';

/** Represents a single command block parsed from OSC 133 sequences. */
export interface CommandBlock {
  /** Unique identifier for this block. */
  id: string;
  /** Line number where the prompt started (OSC 133;A). */
  promptStartLine: number;
  /** Line number where the command input started (OSC 133;B). */
  commandStartLine: number;
  /** Line number where the command output started (OSC 133;C). -1 if not yet reached. */
  commandExecutedLine: number;
  /** Line number where the command finished (OSC 133;D). -1 if not yet reached. */
  commandFinishedLine: number;
  /** Whether this block's output is collapsed. */
  collapsed: boolean;
}

/**
 * Parse an OSC 133 parameter string and return the command letter (A/B/C/D)
 * or null if unrecognized.
 */
export function parseOsc133(data: string): string | null {
  // OSC 133 data is like "A", "B", "C", "D" possibly followed by extra params after ";"
  const trimmed = data.trim();
  if (trimmed.length === 0) return null;
  const letter = trimmed[0];
  if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') {
    return letter;
  }
  return null;
}

let blockIdCounter = 0;

/**
 * Custom xterm.js addon that parses OSC 133 (shell integration) sequences
 * to group terminal output into collapsible command blocks.
 *
 * OSC 133 sequence meanings:
 * - A = PromptStart
 * - B = CommandStart (user typed command follows)
 * - C = CommandExecuted (command output follows)
 * - D = CommandFinished
 */
export class Osc133Addon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private disposables: IDisposable[] = [];
  private blocks: CommandBlock[] = [];
  private currentBlock: Partial<CommandBlock> | null = null;
  private gutterElements: Map<string, HTMLElement> = new Map();
  private contextMenuElement: HTMLElement | null = null;
  private contextMenuDisposer: (() => void) | null = null;

  /** Get all completed and in-progress command blocks. */
  getBlocks(): readonly CommandBlock[] {
    return this.blocks;
  }

  /** Get the current in-progress block, if any. */
  getCurrentBlock(): Partial<CommandBlock> | null {
    return this.currentBlock;
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal;

    // Register OSC 133 handler
    const oscHandler = terminal.parser.registerOscHandler(133, (data: string) => {
      const letter = parseOsc133(data);
      if (!letter) return false;

      const cursorLine = terminal.buffer.active.cursorY + terminal.buffer.active.baseY;

      switch (letter) {
        case 'A':
          // PromptStart — begin a new block
          this.currentBlock = {
            id: `osc133-${++blockIdCounter}`,
            promptStartLine: cursorLine,
            commandStartLine: -1,
            commandExecutedLine: -1,
            commandFinishedLine: -1,
            collapsed: false,
          };
          break;

        case 'B':
          // CommandStart
          if (this.currentBlock) {
            this.currentBlock.commandStartLine = cursorLine;
          }
          break;

        case 'C':
          // CommandExecuted
          if (this.currentBlock) {
            this.currentBlock.commandExecutedLine = cursorLine;
          }
          break;

        case 'D':
          // CommandFinished — finalize the block
          if (this.currentBlock) {
            this.currentBlock.commandFinishedLine = cursorLine;
            const block = this.currentBlock as CommandBlock;
            this.blocks.push(block);
            this.addGutterToggle(block);
            this.currentBlock = null;
          }
          break;
      }

      return true; // Signal that we handled this OSC
    });

    this.disposables.push(oscHandler);

    // Add right-click context menu listener on the terminal element
    const el = terminal.element;
    if (el) {
      const handler = (e: MouseEvent): void => {
        this.handleContextMenu(e);
      };
      el.addEventListener('contextmenu', handler);
      this.contextMenuDisposer = (): void => {
        el.removeEventListener('contextmenu', handler);
      };
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.removeContextMenu();
    if (this.contextMenuDisposer) {
      this.contextMenuDisposer();
      this.contextMenuDisposer = null;
    }
    for (const el of this.gutterElements.values()) {
      el.remove();
    }
    this.gutterElements.clear();
    this.blocks = [];
    this.currentBlock = null;
    this.terminal = null;
  }

  /** Toggle collapse/expand for a block by ID. */
  toggleBlock(blockId: string): void {
    const block = this.blocks.find(b => b.id === blockId);
    if (!block) return;
    block.collapsed = !block.collapsed;
    this.updateGutterToggle(block);
  }

  /** Get text content for a range of lines from the terminal buffer. */
  getLineText(startLine: number, endLine: number): string {
    if (!this.terminal) return '';
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join('\n');
  }

  /** Get command text for a block (between B and C markers). */
  getCommandText(block: CommandBlock): string {
    if (block.commandStartLine < 0 || block.commandExecutedLine < 0) return '';
    const endLine =
      block.commandExecutedLine > block.commandStartLine
        ? block.commandExecutedLine - 1
        : block.commandStartLine;
    return this.getLineText(block.commandStartLine, endLine).trim();
  }

  /** Get output text for a block (between C and D markers). */
  getOutputText(block: CommandBlock): string {
    if (block.commandExecutedLine < 0 || block.commandFinishedLine < 0) return '';
    const startLine = block.commandExecutedLine;
    const endLine =
      block.commandFinishedLine > startLine ? block.commandFinishedLine - 1 : startLine;
    return this.getLineText(startLine, endLine).trim();
  }

  /** Find which block (if any) contains the given viewport row. */
  findBlockAtRow(viewportRow: number): CommandBlock | null {
    if (!this.terminal) return null;
    const absoluteLine = viewportRow + this.terminal.buffer.active.baseY;
    for (const block of this.blocks) {
      if (absoluteLine >= block.promptStartLine && absoluteLine <= block.commandFinishedLine) {
        return block;
      }
    }
    return null;
  }

  private addGutterToggle(block: CommandBlock): void {
    if (!this.terminal?.element) return;

    const toggle = document.createElement('div');
    toggle.className = 'osc133-gutter-toggle';
    toggle.textContent = block.collapsed ? '\u25b6' : '\u25bc'; // ▶ or ▼
    toggle.title = block.collapsed ? 'Expand block' : 'Collapse block';
    toggle.dataset.blockId = block.id;

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleBlock(block.id);
    });

    // Position relative to the prompt start line
    this.positionGutterToggle(toggle, block);

    this.terminal.element.appendChild(toggle);
    this.gutterElements.set(block.id, toggle);
  }

  private updateGutterToggle(block: CommandBlock): void {
    const toggle = this.gutterElements.get(block.id);
    if (!toggle) return;
    toggle.textContent = block.collapsed ? '\u25b6' : '\u25bc';
    toggle.title = block.collapsed ? 'Expand block' : 'Collapse block';
  }

  private positionGutterToggle(toggle: HTMLElement, block: CommandBlock): void {
    if (!this.terminal) return;
    const viewportRow = block.promptStartLine - this.terminal.buffer.active.baseY;
    // Use cell dimensions to position
    const cellHeight = this.terminal.element
      ? this.terminal.element.querySelector('.xterm-rows')?.clientHeight
      : null;
    const rows = this.terminal.rows;
    if (cellHeight && rows > 0) {
      const rowHeight = cellHeight / rows;
      toggle.style.position = 'absolute';
      toggle.style.left = '2px';
      toggle.style.top = `${viewportRow * rowHeight}px`;
      toggle.style.cursor = 'pointer';
      toggle.style.zIndex = '10';
      toggle.style.fontSize = '10px';
      toggle.style.color = '#888';
      toggle.style.userSelect = 'none';
    }
  }

  private handleContextMenu(e: MouseEvent): void {
    if (!this.terminal) return;

    // Determine which row was clicked
    const termElement = this.terminal.element;
    if (!termElement) return;
    const rowsEl = termElement.querySelector('.xterm-rows');
    if (!rowsEl) return;

    const rect = rowsEl.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const rowHeight = rect.height / this.terminal.rows;
    const viewportRow = Math.floor(relY / rowHeight);

    const block = this.findBlockAtRow(viewportRow);
    if (!block) return;

    // Prevent default context menu
    e.preventDefault();

    this.showContextMenu(e.clientX, e.clientY, block);
  }

  private showContextMenu(x: number, y: number, block: CommandBlock): void {
    this.removeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'osc133-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = '1000';
    menu.style.background = '#2d2d2d';
    menu.style.border = '1px solid #555';
    menu.style.borderRadius = '4px';
    menu.style.padding = '4px 0';
    menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';

    const copyCmd = this.createMenuItem('Copy Command', () => {
      const text = this.getCommandText(block);
      void navigator.clipboard.writeText(text);
      this.removeContextMenu();
    });

    const copyOutput = this.createMenuItem('Copy Output', () => {
      const text = this.getOutputText(block);
      void navigator.clipboard.writeText(text);
      this.removeContextMenu();
    });

    menu.appendChild(copyCmd);
    menu.appendChild(copyOutput);

    document.body.appendChild(menu);
    this.contextMenuElement = menu;

    // Close on click elsewhere
    const closeHandler = (): void => {
      this.removeContextMenu();
      document.removeEventListener('click', closeHandler);
    };
    document.addEventListener('click', closeHandler);
  }

  private createMenuItem(label: string, onClick: () => void): HTMLElement {
    const item = document.createElement('div');
    item.className = 'osc133-context-menu-item';
    item.textContent = label;
    item.style.padding = '4px 16px';
    item.style.cursor = 'pointer';
    item.style.color = '#ccc';
    item.style.fontSize = '13px';
    item.addEventListener('mouseenter', () => {
      item.style.background = '#3a3a3a';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });
    item.addEventListener('click', onClick);
    return item;
  }

  private removeContextMenu(): void {
    if (this.contextMenuElement) {
      this.contextMenuElement.remove();
      this.contextMenuElement = null;
    }
  }
}
