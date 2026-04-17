import { describe, test, expect } from 'bun:test';
import {
  tabReducer,
  createInitialTabState,
  tabId,
  getExtension,
  extensionToLanguage,
} from './EditorTabs';
import type { TabState } from './EditorTabs';

// ── Helper tests ───────────────────────────────────────────────

describe('tabId', () => {
  test('combines host and path', () => {
    expect(tabId('linux-beast', '/home/user/file.ts')).toBe('linux-beast:/home/user/file.ts');
  });
});

describe('getExtension', () => {
  test('extracts extension', () => {
    expect(getExtension('file.ts')).toBe('ts');
    expect(getExtension('file.test.tsx')).toBe('tsx');
    expect(getExtension('Makefile')).toBe('');
    expect(getExtension('.gitignore')).toBe('gitignore');
    expect(getExtension('file.')).toBe('');
  });
});

describe('extensionToLanguage', () => {
  test('maps known extensions', () => {
    expect(extensionToLanguage('ts')).toBe('typescript');
    expect(extensionToLanguage('tsx')).toBe('typescript');
    expect(extensionToLanguage('js')).toBe('javascript');
    expect(extensionToLanguage('py')).toBe('python');
    expect(extensionToLanguage('md')).toBe('markdown');
    expect(extensionToLanguage('json')).toBe('json');
    expect(extensionToLanguage('css')).toBe('css');
    expect(extensionToLanguage('html')).toBe('html');
  });

  test('returns null for unknown', () => {
    expect(extensionToLanguage('xyz')).toBeNull();
    expect(extensionToLanguage('')).toBeNull();
  });
});

// ── Tab state machine ──────────────────────────────────────────

describe('tabReducer', () => {
  const initial = createInitialTabState();

  test('OPEN_PREVIEW adds a preview tab', () => {
    const s = tabReducer(initial, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].preview).toBe(true);
    expect(s.activeTabId).toBe('h:/a.ts');
  });

  test('OPEN_PREVIEW replaces previous preview', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe('h:/b.ts');
    expect(s.activeTabId).toBe('h:/b.ts');
  });

  test('OPEN_PREVIEW activates existing tab without duplicating', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe('h:/a.ts');
  });

  test('OPEN_PINNED adds a pinned tab', () => {
    const s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].preview).toBe(false);
    expect(s.activeTabId).toBe('h:/a.ts');
  });

  test('OPEN_PINNED pins an existing preview tab', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    expect(s.tabs[0].preview).toBe(true);
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].preview).toBe(false);
  });

  test('PIN_TAB converts preview to pinned', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, { type: 'PIN_TAB', id: 'h:/a.ts' });
    expect(s.tabs[0].preview).toBe(false);
  });

  test('SET_DIRTY sets dirty flag', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, { type: 'SET_DIRTY', id: 'h:/a.ts', dirty: true });
    expect(s.tabs[0].dirty).toBe(true);
    s = tabReducer(s, { type: 'SET_DIRTY', id: 'h:/a.ts', dirty: false });
    expect(s.tabs[0].dirty).toBe(false);
  });

  test('CLOSE_TAB removes the tab', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, { type: 'CLOSE_TAB', id: 'h:/a.ts' });
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
  });

  test('CLOSE_TAB activates next tab', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/c.ts',
      name: 'c.ts',
    });
    // Activate first tab, close it — should activate the one at same index
    s = tabReducer(s, { type: 'ACTIVATE_TAB', id: 'h:/a.ts' });
    s = tabReducer(s, { type: 'CLOSE_TAB', id: 'h:/a.ts' });
    expect(s.activeTabId).toBe('h:/b.ts');
  });

  test('CLOSE_TAB activates previous if last', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    // Active is b (last), close it
    s = tabReducer(s, { type: 'CLOSE_TAB', id: 'h:/b.ts' });
    expect(s.activeTabId).toBe('h:/a.ts');
  });

  test('ACTIVATE_TAB switches active tab', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    s = tabReducer(s, { type: 'ACTIVATE_TAB', id: 'h:/a.ts' });
    expect(s.activeTabId).toBe('h:/a.ts');
  });

  test('ACTIVATE_TAB ignores unknown id', () => {
    const s = tabReducer(initial, { type: 'ACTIVATE_TAB', id: 'nope' });
    expect(s.activeTabId).toBeNull();
  });

  test('preview tab does not replace pinned tabs', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/b.ts',
      name: 'b.ts',
    });
    expect(s.tabs).toHaveLength(2);
    // Now open another preview — only replaces the preview, not the pinned
    s = tabReducer(s, {
      type: 'OPEN_PREVIEW',
      host: 'h',
      path: '/c.ts',
      name: 'c.ts',
    });
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0].id).toBe('h:/a.ts'); // pinned stays
    expect(s.tabs[1].id).toBe('h:/c.ts'); // preview replaced
  });

  test('close flow: dirty tab needs confirmation (tested via dirty flag)', () => {
    let s = tabReducer(initial, {
      type: 'OPEN_PINNED',
      host: 'h',
      path: '/a.ts',
      name: 'a.ts',
    });
    s = tabReducer(s, { type: 'SET_DIRTY', id: 'h:/a.ts', dirty: true });
    // In the UI, closing a dirty tab shows a modal.
    // The reducer itself allows CLOSE_TAB — the modal is UI-level logic.
    // Here we just verify dirty flag is queryable:
    const tab = s.tabs.find(t => t.id === 'h:/a.ts');
    expect(tab?.dirty).toBe(true);
  });

  test('full flow: open preview → edit (pin) → close', () => {
    let s: TabState = createInitialTabState();

    // Single-click opens preview
    s = tabReducer(s, { type: 'OPEN_PREVIEW', host: 'h', path: '/a.ts', name: 'a.ts' });
    expect(s.tabs[0].preview).toBe(true);

    // Edit pins the tab
    s = tabReducer(s, { type: 'PIN_TAB', id: 'h:/a.ts' });
    expect(s.tabs[0].preview).toBe(false);

    // Mark dirty
    s = tabReducer(s, { type: 'SET_DIRTY', id: 'h:/a.ts', dirty: true });
    expect(s.tabs[0].dirty).toBe(true);

    // Close (after user confirms)
    s = tabReducer(s, { type: 'CLOSE_TAB', id: 'h:/a.ts' });
    expect(s.tabs).toHaveLength(0);
  });
});
