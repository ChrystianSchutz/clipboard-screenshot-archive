import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalStringify,
  diffJson,
  formatPath,
  isJsonObject,
  jsonEquals,
  parseJson,
  previewValue,
  summarize,
  type JsonChange,
  type JsonValue,
} from './json-diff';

/** Parses a JSON literal written inline in a test; fails loudly on a typo in the fixture. */
function json(text: string): JsonValue {
  const result = parseJson(text);
  if (!result.ok) throw new Error(`Bad fixture: ${result.error}`);
  return result.value;
}

describe('parseJson', () => {
  it('parses a valid object', () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('parses top-level primitives, including null', () => {
    expect(parseJson('42')).toEqual({ ok: true, value: 42 });
    expect(parseJson('"text"')).toEqual({ ok: true, value: 'text' });
    expect(parseJson('null')).toEqual({ ok: true, value: null });
  });

  it('strips a leading byte order mark', () => {
    expect(parseJson('﻿{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('ignores surrounding whitespace and CRLF line endings', () => {
    expect(parseJson('\r\n  \t[1, 2]\r\n\r\n')).toEqual({ ok: true, value: [1, 2] });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '  \n\t '],
    ['a lone byte order mark', '﻿'],
  ])('rejects %s as empty input', (_label, text) => {
    expect(parseJson(text)).toEqual({ ok: false, error: 'Empty input' });
  });

  it.each([
    ['a trailing comma', '{"a":1,}'],
    ['single quotes', "{'a':1}"],
    ['a comment', '{"a":1 /* note */}'],
    ['two documents', '{"a":1}{"b":2}'],
    ['plain prose', 'hello world'],
  ])('rejects %s with a non-empty error message', (_label, text) => {
    const result = parseJson(text);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.length > 0).toBe(true);
  });
});

describe('isJsonObject', () => {
  it('is true only for plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('{}')).toBe(false);
  });
});

describe('canonicalize', () => {
  it('sorts object keys recursively by code unit', () => {
    const result = canonicalize(json('{"b":{"z":1,"a":2},"a":0,"B":3}'));

    expect(JSON.stringify(result)).toBe('{"B":3,"a":0,"b":{"a":2,"z":1}}');
  });

  it('keeps array order by default', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('sorts arrays (recursively) when ignoreArrayOrder is set', () => {
    const result = canonicalize(json('[[3,1],{"k":2},[2,1]]'), { ignoreArrayOrder: true });

    expect(result).toEqual([[1, 2], [1, 3], { k: 2 }]);
  });

  it('does not mutate its input', () => {
    const input = json('{"b":[2,1],"a":1}');
    const snapshot = JSON.stringify(input);

    canonicalize(input, { ignoreArrayOrder: true });

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns primitives unchanged', () => {
    expect(canonicalize('x')).toBe('x');
    expect(canonicalize(null)).toBeNull();
  });
});

describe('canonicalStringify', () => {
  it('produces identical text for documents that differ only in key order', () => {
    const left = json('{"user":{"name":"Ada","id":7},"tags":["a","b"]}');
    const right = json('{"tags":["a","b"],"user":{"id":7,"name":"Ada"}}');

    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
  });

  it('pretty-prints with two-space indentation', () => {
    expect(canonicalStringify({ b: 1, a: [true] })).toBe(
      '{\n  "a": [\n    true\n  ],\n  "b": 1\n}',
    );
  });

  it('keeps differently ordered arrays different unless ignoreArrayOrder is set', () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
    expect(canonicalStringify([1, 2], { ignoreArrayOrder: true })).toBe(
      canonicalStringify([2, 1], { ignoreArrayOrder: true }),
    );
  });
});

describe('diffJson', () => {
  describe('objects', () => {
    it('reports no changes for equal documents with different key order', () => {
      const before = json('{"a":1,"b":{"c":[1,2],"d":null}}');
      const after = json('{"b":{"d":null,"c":[1,2]},"a":1}');

      expect(diffJson(before, after)).toEqual([]);
    });

    it('reports an added key with its value', () => {
      expect(diffJson({ a: 1 }, { a: 1, b: { x: true } })).toEqual([
        { type: 'added', path: ['b'], value: { x: true } },
      ]);
    });

    it('reports a removed key with its old value', () => {
      expect(diffJson({ a: 1, b: 'gone' }, { a: 1 })).toEqual([
        { type: 'removed', path: ['b'], value: 'gone' },
      ]);
    });

    it('reports a changed leaf deep inside nested objects with its full path', () => {
      const before = json('{"user":{"address":{"city":"Lodz"}}}');
      const after = json('{"user":{"address":{"city":"Łódź"}}}');

      expect(diffJson(before, after)).toEqual([
        { type: 'changed', path: ['user', 'address', 'city'], before: 'Lodz', after: 'Łódź' },
      ]);
    });

    it('treats a key holding null as present, not missing', () => {
      expect(diffJson({ a: null }, {})).toEqual([{ type: 'removed', path: ['a'], value: null }]);
    });

    it('does not confuse inherited property names with own keys', () => {
      expect(diffJson({}, json('{"constructor":1,"toString":2}'))).toEqual([
        { type: 'added', path: ['constructor'], value: 1 },
        { type: 'added', path: ['toString'], value: 2 },
      ]);
    });
  });

  describe('type changes', () => {
    it.each<[string, JsonValue, JsonValue]>([
      ['object → array', {}, []],
      ['array → object', [1], { 0: 1 }],
      ['number → string', 1, '1'],
      ['string → null', 'x', null],
      ['null → object', null, {}],
      ['boolean → number', false, 0],
    ])('reports %s as a single change at that path', (_label, before, after) => {
      expect(diffJson({ v: before }, { v: after })).toEqual([
        { type: 'changed', path: ['v'], before, after },
      ]);
    });

    it('reports a changed root value with an empty path', () => {
      expect(diffJson([1], { a: 1 })).toEqual([
        { type: 'changed', path: [], before: [1], after: { a: 1 } },
      ]);
    });

    it('treats null and null as equal', () => {
      expect(diffJson(null, null)).toEqual([]);
    });
  });

  describe('ordered arrays (default)', () => {
    it('compares by index and reports a changed element', () => {
      expect(diffJson([1, 2, 3], [1, 9, 3])).toEqual([
        { type: 'changed', path: [1], before: 2, after: 9 },
      ]);
    });

    it('reports extra trailing elements as added at their index', () => {
      expect(diffJson([1], [1, 2, 3])).toEqual([
        { type: 'added', path: [1], value: 2 },
        { type: 'added', path: [2], value: 3 },
      ]);
    });

    it('reports missing trailing elements as removed at their index', () => {
      expect(diffJson(['a', 'b', 'c'], ['a'])).toEqual([
        { type: 'removed', path: [1], value: 'b' },
        { type: 'removed', path: [2], value: 'c' },
      ]);
    });

    it('treats a reordered array as changed element by element', () => {
      expect(diffJson([1, 2], [2, 1])).toEqual([
        { type: 'changed', path: [0], before: 1, after: 2 },
        { type: 'changed', path: [1], before: 2, after: 1 },
      ]);
    });

    it('descends into objects inside arrays', () => {
      const before = json('[{"id":1,"name":"a"}]');
      const after = json('[{"name":"b","id":1}]');

      expect(diffJson(before, after)).toEqual([
        { type: 'changed', path: [0, 'name'], before: 'a', after: 'b' },
      ]);
    });
  });

  describe('unordered arrays (ignoreArrayOrder)', () => {
    const unordered = { ignoreArrayOrder: true } as const;

    it('treats a permutation as equal', () => {
      expect(diffJson([1, 2, 3], [3, 1, 2], unordered)).toEqual([]);
    });

    it('matches objects regardless of their key order', () => {
      const before = json('[{"id":1,"tag":"x"},{"id":2,"tag":"y"}]');
      const after = json('[{"tag":"y","id":2},{"tag":"x","id":1}]');

      expect(diffJson(before, after, unordered)).toEqual([]);
    });

    it('applies multiset semantics to nested arrays too', () => {
      expect(diffJson({ m: [[1, 2], [3]] }, { m: [[3], [2, 1]] }, unordered)).toEqual([]);
    });

    it('counts duplicates: [1,1,2] vs [1,2,2] is one removal and one addition', () => {
      expect(diffJson([1, 1, 2], [1, 2, 2], unordered)).toEqual([
        { type: 'removed', path: [1], value: 1 },
        { type: 'added', path: [2], value: 2 },
      ]);
    });

    it('reports a dropped duplicate even though the value still occurs', () => {
      expect(diffJson(['a', 'a'], ['a'], unordered)).toEqual([
        { type: 'removed', path: [1], value: 'a' },
      ]);
    });

    it('reports a modified element as removed (old index) plus added (new index)', () => {
      const before = json('[{"id":1},{"id":2}]');
      const after = json('[{"id":2},{"id":3}]');

      expect(diffJson(before, after, unordered)).toEqual([
        { type: 'removed', path: [0], value: { id: 1 } },
        { type: 'added', path: [1], value: { id: 3 } },
      ]);
    });

    it('lists all removals before additions, each sorted by index', () => {
      const changes = diffJson(['x', 'keep', 'y'], ['b', 'keep', 'a'], unordered);

      expect(changes.map((change) => [change.type, change.path])).toEqual([
        ['removed', [0]],
        ['removed', [2]],
        ['added', [0]],
        ['added', [2]],
      ]);
    });

    it('keeps the number 1 and the string "1" distinct when matching elements', () => {
      expect(diffJson([1], ['1'], unordered)).toEqual([
        { type: 'removed', path: [0], value: 1 },
        { type: 'added', path: [0], value: '1' },
      ]);
    });
  });

  describe('ordering of changes', () => {
    it('sorts sibling keys by code unit, independent of input order', () => {
      const changes = diffJson({ b: 1, a: 1, B: 1 }, { a: 2, B: 2, b: 2 });

      expect(changes.map((change) => change.path)).toEqual([['B'], ['a'], ['b']]);
    });

    it('returns the same list when the inputs are given in a different key order', () => {
      const first = diffJson(json('{"z":1,"m":{"y":1,"x":1}}'), json('{"z":2,"m":{"x":2}}'));
      const second = diffJson(json('{"m":{"x":1,"y":1},"z":1}'), json('{"m":{"x":2},"z":2}'));

      expect(second).toEqual(first);
      expect(first.map((change) => formatPath(change.path))).toEqual(['$.m.x', '$.m.y', '$.z']);
    });
  });

  it('treats -0 and 0 as the same number', () => {
    expect(diffJson(json('{"n":-0}'), json('{"n":0}'))).toEqual([]);
  });

  describe('number precision', () => {
    it('keeps adjacent 64-bit ids apart (they collapse into one double)', () => {
      const changes = diffJson(json('{"id":9007199254740992}'), json('{"id":9007199254740993}'));

      expect(changes).toHaveLength(1);
      expect(changes.map((change) => [formatPath(change.path), change.type])).toEqual([
        ['$.id', 'changed'],
      ]);
      expect(previewValue((changes[0] as { after: JsonValue }).after)).toBe('9007199254740993');
    });

    it('keeps decimals beyond double precision apart', () => {
      expect(diffJson(json('[0.10000000000000000001]'), json('[0.1]'))).toHaveLength(1);
    });

    it.each([
      ['1.0', '1'],
      ['1e2', '100'],
      ['12345678901234567890', '1.2345678901234567890e19'],
      ['-0', '0'],
    ])('still treats %s and %s as the same number', (left, right) => {
      expect(diffJson(json(`[${left}]`), json(`[${right}]`))).toEqual([]);
    });

    it('matches big numbers by value when ignoring array order', () => {
      const a = json('[9007199254740993, 9007199254740992]');
      const b = json('[9007199254740992.0, 90071992547409930e-1]');

      expect(diffJson(a, b, { ignoreArrayOrder: true })).toEqual([]);
      expect(
        diffJson(a, json('[9007199254740992, 9007199254740992]'), { ignoreArrayOrder: true }),
      ).toHaveLength(2);
    });

    it('writes the exact digits back when serialising', () => {
      expect(canonicalStringify(json('{"b":12345678901234567891,"a":1}'))).toBe(
        ['{', '  "a": 1,', '  "b": 12345678901234567891', '}'].join('\n'),
      );
    });

    it('keeps plain numbers as JavaScript numbers', () => {
      expect(parseJson('{"n":42,"f":1.5}')).toEqual({ ok: true, value: { n: 42, f: 1.5 } });
    });
  });

  describe('an own "__proto__" key', () => {
    it('is kept by canonicalize instead of setting the prototype', () => {
      const canonical = canonicalize(json('{"__proto__":{"admin":true},"z":1}'));

      expect(Object.keys(canonical as object)).toEqual(['__proto__', 'z']);
      expect(canonicalStringify(json('{"__proto__":1}'))).toBe(
        ['{', '  "__proto__": 1', '}'].join('\n'),
      );
    });

    it('counts as a difference when ignoring array order', () => {
      expect(
        diffJson(json('[{"__proto__":1}]'), json('[{}]'), { ignoreArrayOrder: true }),
      ).toHaveLength(2);
    });

    it('is diffed like any other key', () => {
      expect(diffJson(json('{"__proto__":1}'), json('{"__proto__":2}'))).toEqual([
        { type: 'changed', path: ['__proto__'], before: 1, after: 2 },
      ]);
    });
  });
});

describe('jsonEquals', () => {
  it('ignores key order', () => {
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('respects array order unless told otherwise', () => {
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals([1, 2], [2, 1], { ignoreArrayOrder: true })).toBe(true);
  });
});

describe('formatPath', () => {
  it.each<[string, (string | number)[], string]>([
    ['the root', [], '$'],
    ['identifier keys with dots', ['user', 'name'], '$.user.name'],
    ['array indexes with brackets', ['items', 2, 'id'], '$.items[2].id'],
    ['keys with dashes', ['headers', 'content-type'], '$.headers["content-type"]'],
    ['keys with spaces', ['a b'], '$["a b"]'],
    ['keys starting with a digit', ['1st'], '$["1st"]'],
    ['numeric-looking object keys as strings, not indexes', ['0'], '$["0"]'],
    ['the empty key', [''], '$[""]'],
    ['keys containing quotes, escaped', ['say "hi"'], '$["say \\"hi\\""]'],
    ['non-ASCII keys', ['zażółć'], '$["zażółć"]'],
    ['identifier keys with $ and _', ['$id', '_rev'], '$.$id._rev'],
  ])('renders %s', (_label, path, expected) => {
    expect(formatPath(path)).toBe(expected);
  });
});

describe('summarize', () => {
  it('counts each change type', () => {
    const changes: JsonChange[] = [
      { type: 'added', path: ['a'], value: 1 },
      { type: 'added', path: ['b'], value: 2 },
      { type: 'removed', path: ['c'], value: 3 },
      { type: 'changed', path: ['d'], before: 1, after: 2 },
    ];

    expect(summarize(changes)).toEqual({ added: 2, removed: 1, changed: 1 });
  });

  it('returns zeros for no changes', () => {
    expect(summarize([])).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe('previewValue', () => {
  it('quotes strings and serialises containers compactly', () => {
    expect(previewValue('hi')).toBe('"hi"');
    expect(previewValue({ a: [1, null] })).toBe('{"a":[1,null]}');
    expect(previewValue(null)).toBe('null');
  });

  it('keeps text that is exactly maxLength long', () => {
    expect(previewValue('abcd', 6)).toBe('"abcd"');
  });

  it('truncates longer text to exactly maxLength characters, ending in an ellipsis', () => {
    const preview = previewValue('abcdefgh', 6);

    expect(preview).toBe('"abcd…');
    expect(preview).toHaveLength(6);
  });

  it('defaults to 80 characters', () => {
    const preview = previewValue('x'.repeat(200));

    expect(preview).toHaveLength(80);
    expect(preview.endsWith('…')).toBe(true);
  });
});
