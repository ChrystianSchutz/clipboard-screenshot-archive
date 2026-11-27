import { isCategory, type Category } from './categories';
import { CLIP_KINDS, type ClipKind } from './types';

/**
 * Search box mini-language, so the keyboard never has to leave the input:
 *
 *   timeout app:chrome #error        → "timeout", from Chrome, tagged Error
 *   app:"VS Code" kind:json is:pinned
 *   cat:sql  is:url                 → `is:` accepts a kind, a category or `pinned`
 *
 * Unknown `key:value` tokens stay part of the text, so searching for "http://x" or "a:b" works.
 */
export interface ParsedSearch {
  /** Free text left after removing the operators. */
  readonly text: string;
  /** Raw app name as typed; the UI resolves it against the known apps. */
  readonly app: string | null;
  readonly kind: ClipKind | null;
  readonly category: Category | null;
  readonly pinned: boolean;
}

const TOKEN = /(?:^|\s)(?:(#)([\w-]+)|(app|kind|cat|is):(?:"([^"]*)"|(\S+)))(?=\s|$)/gi;

const isKind = (value: string): value is ClipKind =>
  (CLIP_KINDS as readonly string[]).includes(value);

/** Which filter an operator sets. */
export type OperatorKey = 'app' | 'kind' | 'category' | 'pinned';

type Operator =
  | { readonly key: 'app'; readonly value: string }
  | { readonly key: 'kind'; readonly value: ClipKind }
  | { readonly key: 'category'; readonly value: Category }
  | { readonly key: 'pinned' };

/** Reads one `TOKEN` match; `null` when it only looks like an operator (`#nope`, `is:big`). */
function readOperator(
  hash: string | undefined,
  tag: string | undefined,
  key: string | undefined,
  quoted: string | undefined,
  bare: string | undefined,
): Operator | null {
  if (hash !== undefined && tag !== undefined) {
    const value = tag.toLowerCase();
    return isCategory(value) ? { key: 'category', value } : null;
  }
  const value = (quoted ?? bare ?? '').trim();
  const lower = value.toLowerCase();
  switch (key?.toLowerCase()) {
    case 'app':
      return value === '' ? null : { key: 'app', value };
    case 'kind':
      return isKind(lower) ? { key: 'kind', value: lower } : null;
    case 'cat':
      return isCategory(lower) ? { key: 'category', value: lower } : null;
    case 'is':
      if (lower === 'pinned') return { key: 'pinned' };
      if (isKind(lower)) return { key: 'kind', value: lower };
      if (isCategory(lower)) return { key: 'category', value: lower };
      return null;
    default:
      return null;
  }
}

/** Calls `visit` for every operator in `input`; returns the input with the visited ones replaced. */
function replaceOperators(input: string, visit: (operator: Operator) => boolean): string {
  return input.replace(
    TOKEN,
    (
      whole,
      hash: string | undefined,
      tag: string | undefined,
      key: string | undefined,
      quoted: string | undefined,
      bare: string | undefined,
    ) => {
      const operator = readOperator(hash, tag, key, quoted, bare);
      return operator && visit(operator) ? ' ' : whole;
    },
  );
}

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function parseSearch(input: string): ParsedSearch {
  let app: string | null = null;
  let kind: ClipKind | null = null;
  let category: Category | null = null;
  let pinned = false;

  const text = replaceOperators(input, (operator) => {
    switch (operator.key) {
      case 'app':
        app = operator.value;
        break;
      case 'kind':
        kind = operator.value;
        break;
      case 'category':
        category = operator.value;
        break;
      case 'pinned':
        pinned = true;
        break;
    }
    return true;
  });

  return { text: tidy(text), app, kind, category, pinned };
}

/**
 * Removes every operator that sets `key` from the search text and keeps everything else as
 * typed (other operators included): `removeOperator('a #sql app:x b', 'category')` → `'a app:x b'`.
 */
export function removeOperator(input: string, key: OperatorKey): string {
  return tidy(replaceOperators(input, (operator) => operator.key === key));
}

/**
 * Resolves a typed app name against the apps seen in the history: exact match first (ignoring
 * case), then the first app that starts with it, then the first that contains it.
 */
export function resolveApp(typed: string, apps: readonly string[]): string | null {
  const needle = typed.toLowerCase();
  return (
    apps.find((app) => app.toLowerCase() === needle) ??
    apps.find((app) => app.toLowerCase().startsWith(needle)) ??
    apps.find((app) => app.toLowerCase().includes(needle)) ??
    null
  );
}
