/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE KEYBOARD MAP, AS DATA
 * =============================================================================
 *
 * ONE SOURCE OF TRUTH. The handler dispatches from this table, the help overlay
 * is generated from this table, and every `<KeyHint>` chip in the product reads
 * its glyphs out of this table. The classic failure — a tooltip that says `⌘K`
 * next to a handler that listens for `/` — is not available here, because there
 * is only one place to be wrong.
 *
 * The map is deliberately small. An instrument with forty shortcuts has no
 * shortcuts, because nobody can hold forty of anything. Eleven bindings, three
 * groups, every one of them a verb the product actually performs.
 *
 * This module knows NOTHING about the store: it matches events to binding ids
 * and stops. `handleKey()` in the store does the dispatch, so the map stays
 * importable by a copy deck, a help overlay or a test without dragging the
 * whole application state in behind it.
 * =============================================================================
 */

import { RUNGS } from '@/engine';
import type { Rung } from '@/engine';

/** Every action the keyboard can reach. Stable ids — the copy deck keys off these. */
export type KeyActionId =
  | 'search'
  | 'atlas'
  | 'inspector'
  | 'receipt'
  | 'timeline'
  | 'clear-focus'
  | 'run-query'
  | 'analyst'
  | 'help'
  | 'rung-continent'
  | 'rung-island'
  | 'rung-asset'
  | 'rung-passage'
  | 'ascend';

/** The three groups the help overlay renders as columns. */
export type KeyGroup = 'navigate' | 'panels' | 'query';

export interface KeyBinding {
  id: KeyActionId;
  /**
   * DISPLAY glyphs, exactly as `<KeyHint keys={...} />` should render them.
   * Multiple entries mean "these keys, in sequence" is NOT the semantics — each
   * entry is one key of the same chord-free binding, so all current bindings
   * carry exactly one.
   */
  keys: string[];
  /**
   * The `KeyboardEvent.key` values, lowercased, that trigger it. `?` and `/`
   * are separate physical results of the same key on most layouts, which is why
   * they are two bindings rather than one with a shift flag.
   */
  codes: string[];
  /** Human label for the help overlay. Imperative, lowercase-first, no period. */
  label: string;
  group: KeyGroup;
  /** For the four rung jumps: which rung. `null` for everything else. */
  rung: Rung | null;
}

/**
 * THE MAP.
 *
 * Order is the order the help overlay lists them in, so it reads as a tour of
 * the product: move around, open things, ask something.
 */
export const KEYMAP: readonly KeyBinding[] = Object.freeze([
  /* ---- navigate ------------------------------------------------------- */
  { id: 'rung-continent', keys: ['1'], codes: ['1'], label: 'jump to the continent rung', group: 'navigate', rung: RUNGS[0] },
  { id: 'rung-island', keys: ['2'], codes: ['2'], label: 'jump to the island rung', group: 'navigate', rung: RUNGS[1] },
  { id: 'rung-asset', keys: ['3'], codes: ['3'], label: 'jump to the asset rung', group: 'navigate', rung: RUNGS[2] },
  { id: 'rung-passage', keys: ['4'], codes: ['4'], label: 'jump to the passage rung', group: 'navigate', rung: RUNGS[3] },
  { id: 'ascend', keys: ['Backspace'], codes: ['backspace'], label: 'ascend one rung', group: 'navigate', rung: null },
  { id: 'clear-focus', keys: ['Esc'], codes: ['escape'], label: 'clear focus and selection', group: 'navigate', rung: null },
  { id: 'atlas', keys: ['A'], codes: ['a'], label: 'Atlas Mode — all four rungs at once', group: 'navigate', rung: null },

  /* ---- panels --------------------------------------------------------- */
  { id: 'inspector', keys: ['I'], codes: ['i'], label: 'Inspector', group: 'panels', rung: null },
  { id: 'receipt', keys: ['P'], codes: ['p'], label: 'Provenance — the render trace', group: 'panels', rung: null },
  { id: 'timeline', keys: ['T'], codes: ['t'], label: 'Timeline', group: 'panels', rung: null },
  { id: 'analyst', keys: ['G'], codes: ['g'], label: 'Analyst Mode', group: 'panels', rung: null },
  { id: 'help', keys: ['?'], codes: ['?'], label: 'this list, and the glossary', group: 'panels', rung: null },

  /* ---- query ---------------------------------------------------------- */
  { id: 'search', keys: ['/'], codes: ['/'], label: 'command search', group: 'query', rung: null },
  { id: 'run-query', keys: ['Q'], codes: ['q'], label: 'render the staged question', group: 'query', rung: null },
] as const);

/** Group ids with their headings, in overlay order. */
export const KEY_GROUPS: readonly { id: KeyGroup; label: string }[] = Object.freeze([
  { id: 'navigate', label: 'Navigate' },
  { id: 'panels', label: 'Panels' },
  { id: 'query', label: 'Query' },
] as const);

/** O(1) lookup by action id. */
const BY_ID: Readonly<Record<KeyActionId, KeyBinding>> = Object.freeze(
  KEYMAP.reduce((acc, binding) => {
    acc[binding.id] = binding;
    return acc;
  }, {} as Record<KeyActionId, KeyBinding>),
);

/** The binding for an action. Throws on an unknown id — that is a typo, not a runtime condition. */
export function bindingFor(id: KeyActionId): KeyBinding {
  const binding = BY_ID[id];
  if (binding === undefined) throw new Error(`[state/keys] no binding declared for "${id}".`);
  return binding;
}

/** The display glyphs for `<KeyHint keys={keyHintFor('search')} />`. */
export function keyHintFor(id: KeyActionId): string[] {
  return [...bindingFor(id).keys];
}

/** Bindings in one group, for a help-overlay column. */
export function bindingsInGroup(group: KeyGroup): KeyBinding[] {
  return KEYMAP.filter((b) => b.group === group);
}

/** The shape `matchBinding` needs. Typed structurally so a test can pass a literal. */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}

/**
 * True when the event came from somewhere the user is typing.
 *
 * The command bar is a text input and `/` inside it is a slash, not a shortcut.
 * Checked structurally rather than with `instanceof HTMLInputElement` so this
 * also holds for a synthetic event in a test.
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Which binding, if any, this event triggers.
 *
 * A modifier means the user is talking to the browser or the OS, not to us:
 * ⌘P must stay Print and ⌃T must stay New Tab. Shift is allowed, because `?`
 * only exists with it.
 */
export function matchBinding(event: KeyEventLike): KeyBinding | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  if (isEditableTarget(event.target ?? null)) {
    // One exception, and it is the important one: Escape has to be able to leave
    // a field the user is trapped in.
    const key = String(event.key).toLowerCase();
    return key === 'escape' ? bindingFor('clear-focus') : null;
  }
  const key = String(event.key).toLowerCase();
  for (const binding of KEYMAP) {
    if (binding.codes.includes(key)) return binding;
  }
  return null;
}
