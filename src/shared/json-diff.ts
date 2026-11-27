/**
 * Structural JSON diff that ignores object key order.
 *
 * Two API responses that differ only in key order (`{"a":1,"b":2}` vs `{"b":2,"a":1}`) are equal here.
 * Arrays are compared by index by default; with `ignoreArrayOrder` they are compared as multisets,
 * which suits responses whose list order is not guaranteed (e.g. unordered SQL results).
 *
 * Numbers keep their exact value: a 64-bit id such as 9007199254740993 does not collapse into its
 * neighbour 9007199254740992, as it would after a plain `JSON.parse`.
 *
 * Pure and dependency-free: it runs in the renderer and is covered by unit tests.
 */

/**
 * A number whose JSON text a double cannot hold exactly (big integers, extreme precision), kept
 * as its source text via `JSON.rawJSON`. `JSON.stringify` writes those digits back verbatim.
 */
export interface LosslessNumber {
  readonly rawJSON: string;
}

export type JsonPrimitive = null | boolean | number | LosslessNumber | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonPath = readonly (string | number)[];

export type JsonChange =
  | { readonly type: 'added'; readonly path: JsonPath; readonly value: JsonValue }
  | { readonly type: 'removed'; readonly path: JsonPath; readonly value: JsonValue }
  | {
      readonly type: 'changed';
      readonly path: JsonPath;
      readonly before: JsonValue;
      readonly after: JsonValue;
    };

export interface JsonDiffOptions {
  /** Compare arrays as unordered collections. Default `false`. */
  readonly ignoreArrayOrder?: boolean;
}

export type ParseResult =
  { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: string };

const BOM = '﻿';

/**
 * JSON source text access (ES2025: reviver `context.source`, `JSON.rawJSON`, `JSON.isRawJSON`).
 * V8 ships it (Chrome 114+, so every Electron we support, and Node 21+); TypeScript's lib does not
 * describe it yet. https://github.com/tc39/proposal-json-parse-with-source
 */
const SourceJSON = JSON as unknown as {
  parse(
    text: string,
    reviver: (key: string, value: unknown, context: { readonly source?: string }) => unknown,
  ): unknown;
  rawJSON(text: string): LosslessNumber;
  isRawJSON(value: unknown): value is LosslessNumber;
};

/** Parses clipboard text as JSON. Tolerates a BOM and surrounding whitespace, nothing else. */
export function parseJson(text: string): ParseResult {
  const trimmed = (text.startsWith(BOM) ? text.slice(1) : text).trim();
  if (trimmed === '') return { ok: false, error: 'Empty input' };
  try {
    return { ok: true, value: SourceJSON.parse(trimmed, keepExactNumbers) as JsonValue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Reviver: a number whose double differs from its source text keeps the source text. */
function keepExactNumbers(
  _key: string,
  value: unknown,
  context: { readonly source?: string },
): unknown {
  const source = context.source;
  if (typeof value !== 'number' || source === undefined || source === String(value)) return value;
  return decimalKey(source) === decimalKey(String(value)) ? value : SourceJSON.rawJSON(source);
}

/**
 * Canonical form of a decimal number literal, exact at any precision: `1.50`, `15e-1` and `1.5`
 * all give `15e-1`; `-0` gives `0`. Text that is not a finite literal is returned as it is.
 */
function decimalKey(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return text;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const digits = (whole + fraction).replace(/^0+/, '');
  if (digits === '') return '0';
  const significant = digits.replace(/0+$/, '');
  const scale = Number(exponent) - fraction.length + (digits.length - significant.length);
  return `${sign}${significant}e${String(scale)}`;
}

export function isLosslessNumber(value: unknown): value is LosslessNumber {
  return SourceJSON.isRawJSON(value);
}

export function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isLosslessNumber(value)
  );
}

function sameNumber(a: number | LosslessNumber, b: number | LosslessNumber): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  const text = (n: number | LosslessNumber): string =>
    typeof n === 'number' ? String(n) : n.rawJSON;
  return decimalKey(text(a)) === decimalKey(text(b));
}

/** Serialisation used to sort and match values: equal values give equal keys. */
function sortKey(value: JsonValue): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isLosslessNumber(item) ? SourceJSON.rawJSON(decimalKey(item.rawJSON)) : item,
  );
}

type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

function kindOf(value: JsonValue): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isLosslessNumber(value)) return 'number';
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

/** Code-unit order: deterministic and locale-independent, like `JSON.stringify` key ordering tools. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Returns a deep copy with object keys sorted (and arrays sorted too when `ignoreArrayOrder`),
 * so that two semantically equal documents serialise to the same string.
 */
export function canonicalize(value: JsonValue, options: JsonDiffOptions = {}): JsonValue {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item, options));
    if (!options.ignoreArrayOrder) return items;
    return items
      .map((item) => ({ item, key: sortKey(item) }))
      .sort((x, y) => compareStrings(x.key, y.key))
      .map(({ item }) => item);
  }
  if (isJsonObject(value)) {
    // No prototype, so an own "__proto__" key is stored as data instead of hitting the setter.
    const sorted = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort(compareStrings)) {
      sorted[key] = canonicalize(value[key] as JsonValue, options);
    }
    return sorted;
  }
  return value;
}

/** Canonical pretty-printed JSON: identical output for documents that differ only in key order. */
export function canonicalStringify(value: JsonValue, options: JsonDiffOptions = {}): string {
  return JSON.stringify(canonicalize(value, options), null, 2);
}

export function jsonEquals(a: JsonValue, b: JsonValue, options: JsonDiffOptions = {}): boolean {
  return diffJson(a, b, options).length === 0;
}

/** All differences between `before` and `after`, in a stable, path-sorted order. */
export function diffJson(
  before: JsonValue,
  after: JsonValue,
  options: JsonDiffOptions = {},
): JsonChange[] {
  const changes: JsonChange[] = [];
  walk(before, after, [], options, changes);
  return changes;
}

function walk(
  a: JsonValue,
  b: JsonValue,
  path: JsonPath,
  options: JsonDiffOptions,
  out: JsonChange[],
): void {
  const kindA = kindOf(a);
  const kindB = kindOf(b);

  if (kindA !== kindB) {
    out.push({ type: 'changed', path, before: a, after: b });
    return;
  }

  if (kindA === 'object') {
    walkObject(a as Record<string, JsonValue>, b as Record<string, JsonValue>, path, options, out);
    return;
  }

  if (kindA === 'array') {
    if (options.ignoreArrayOrder)
      walkUnorderedArray(a as JsonValue[], b as JsonValue[], path, options, out);
    else walkOrderedArray(a as JsonValue[], b as JsonValue[], path, options, out);
    return;
  }

  const same =
    kindA === 'number'
      ? sameNumber(a as number | LosslessNumber, b as number | LosslessNumber)
      : a === b;
  if (!same) out.push({ type: 'changed', path, before: a, after: b });
}

function walkObject(
  a: Record<string, JsonValue>,
  b: Record<string, JsonValue>,
  path: JsonPath,
  options: JsonDiffOptions,
  out: JsonChange[],
): void {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort(compareStrings)) {
    const inA = Object.hasOwn(a, key);
    const inB = Object.hasOwn(b, key);
    const childPath = [...path, key];
    if (inA && inB) walk(a[key] as JsonValue, b[key] as JsonValue, childPath, options, out);
    else if (inA) out.push({ type: 'removed', path: childPath, value: a[key] as JsonValue });
    else out.push({ type: 'added', path: childPath, value: b[key] as JsonValue });
  }
}

function walkOrderedArray(
  a: JsonValue[],
  b: JsonValue[],
  path: JsonPath,
  options: JsonDiffOptions,
  out: JsonChange[],
): void {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++)
    walk(a[i] as JsonValue, b[i] as JsonValue, [...path, i], options, out);
  for (let i = shared; i < a.length; i++)
    out.push({ type: 'removed', path: [...path, i], value: a[i] as JsonValue });
  for (let i = shared; i < b.length; i++)
    out.push({ type: 'added', path: [...path, i], value: b[i] as JsonValue });
}

/**
 * Multiset comparison: every element of `a` is matched with an equal element of `b`.
 * Unmatched elements are reported at their own index (removed from `a`, added in `b`).
 */
function walkUnorderedArray(
  a: JsonValue[],
  b: JsonValue[],
  path: JsonPath,
  options: JsonDiffOptions,
  out: JsonChange[],
): void {
  const keyOf = (value: JsonValue): string => sortKey(canonicalize(value, options));
  const unmatchedB = new Map<string, number[]>();
  b.forEach((value, index) => {
    const key = keyOf(value);
    const bucket = unmatchedB.get(key);
    if (bucket) bucket.push(index);
    else unmatchedB.set(key, [index]);
  });

  const removed: JsonChange[] = [];
  a.forEach((value, index) => {
    const bucket = unmatchedB.get(keyOf(value));
    if (bucket && bucket.length > 0) bucket.shift();
    else removed.push({ type: 'removed', path: [...path, index], value });
  });

  const added: JsonChange[] = [];
  for (const indexes of unmatchedB.values()) {
    for (const index of indexes)
      added.push({ type: 'added', path: [...path, index], value: b[index] as JsonValue });
  }
  added.sort((x, y) => (x.path.at(-1) as number) - (y.path.at(-1) as number));

  out.push(...removed, ...added);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** JSONPath-style rendering: `$`, `$.user.name`, `$.items[2]`, `$["content-type"]`. */
export function formatPath(path: JsonPath): string {
  let result = '$';
  for (const segment of path) {
    if (typeof segment === 'number') result += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) result += `.${segment}`;
    else result += `[${JSON.stringify(segment)}]`;
  }
  return result;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

export function summarize(changes: readonly JsonChange[]): DiffSummary {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const change of changes) {
    if (change.type === 'added') added++;
    else if (change.type === 'removed') removed++;
    else changed++;
  }
  return { added, removed, changed };
}

/** Short single-line rendering of a value for change lists: strings quoted, containers abbreviated. */
export function previewValue(value: JsonValue, maxLength = 80): string {
  const text = JSON.stringify(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
