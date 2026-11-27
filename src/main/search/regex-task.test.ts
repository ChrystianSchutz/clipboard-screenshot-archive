import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryPage } from '@shared/types';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase, registerRegexFunction } from '../storage/database';
import { isRegexQuery, runRegexTask } from './regex-task';

describe('runRegexTask', () => {
  let db: DatabaseSync;
  let repository: ClipRepository;

  const add = (content: string, copiedAt: number): void => {
    repository.record({
      content,
      kind: 'text',
      categories: [],
      source: { app: null, exe: null, url: null },
      copiedAt,
    });
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    registerRegexFunction(db); // as the worker's connection does
    repository = new ClipRepository(db);
    add('order 1234 shipped', 1);
    add('no digits here', 2);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the matching page with match ranges in each row title', () => {
    const page = runRegexTask(repository, {
      op: 'query',
      query: { text: '\\d+', regex: true },
    }) as HistoryPage;

    expect(page.clips.map((clip) => clip.preview)).toEqual(['order 1234 shipped']);
    expect(page.clips[0]?.titleMatches).toEqual([[6, 10]]);
  });

  it('finds ranges in a given text', () => {
    expect(runRegexTask(repository, { op: 'ranges', pattern: 'o', text: 'foo' })).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('rejects an invalid pattern with the compiler message', () => {
    expect(() => runRegexTask(repository, { op: 'ranges', pattern: '(a+)+', text: 'aaa' })).toThrow(
      /Nested quantifiers/,
    );
  });
});

describe('the main connection', () => {
  it('cannot run a regex at all: REGEXP exists only in the worker', () => {
    const db = openDatabase(':memory:');
    try {
      expect(() => new ClipRepository(db).query({ text: 'a', regex: true })).toThrow(/regexp/i);
    } finally {
      db.close();
    }
  });
});

describe('isRegexQuery', () => {
  it.each([
    [{ text: 'a+', regex: true }, true],
    [{ text: '  ', regex: true }, false],
    [{ regex: true }, false],
    [{ text: 'a+' }, false],
  ])('%j -> %s', (query, expected) => {
    expect(isRegexQuery(query)).toBe(expected);
  });
});
