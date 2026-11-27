import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { responseParser } from './worker-protocol';

/** A tiny stand-in for a real result schema (OCR results, image analyses). */
const parse = responseParser(z.object({ words: z.number().int().nonnegative() }));

describe('responseParser', () => {
  it('accepts a ready message', () => {
    expect(parse({ type: 'ready', worker: 'tesseract.js@7.0.0/eng+pol' })).toEqual({
      type: 'ready',
      worker: 'tesseract.js@7.0.0/eng+pol',
    });
  });

  it('accepts a result that matches the result schema', () => {
    expect(parse({ type: 'result', id: 7, result: { words: 12 } })).toEqual({
      type: 'result',
      id: 7,
      result: { words: 12 },
    });
  });

  it('accepts an error message', () => {
    expect(parse({ type: 'error', id: 3, message: 'image too small' })).toEqual({
      type: 'error',
      id: 3,
      message: 'image too small',
    });
  });

  it('drops fields the protocol does not know', () => {
    expect(parse({ type: 'error', id: 3, message: 'boom', stack: 'at worker.js:1' })).toEqual({
      type: 'error',
      id: 3,
      message: 'boom',
    });
  });

  it('rejects values that are not protocol messages at all', () => {
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse('ready')).toBeNull();
    expect(parse(42)).toBeNull();
    expect(parse({})).toBeNull();
  });

  it('rejects an unknown message type', () => {
    expect(parse({ type: 'progress', id: 1, percent: 50 })).toBeNull();
  });

  it('rejects results and errors without a whole-number id', () => {
    expect(parse({ type: 'result', result: { words: 1 } })).toBeNull();
    expect(parse({ type: 'result', id: '1', result: { words: 1 } })).toBeNull();
    expect(parse({ type: 'error', id: 1.5, message: 'boom' })).toBeNull();
  });

  it('rejects a result that fails the result schema', () => {
    expect(parse({ type: 'result', id: 1, result: { words: -1 } })).toBeNull();
    expect(parse({ type: 'result', id: 1, result: 'twelve words' })).toBeNull();
    expect(parse({ type: 'result', id: 1 })).toBeNull();
  });

  it('rejects over-long worker ids and error messages', () => {
    expect(parse({ type: 'ready', worker: 'w'.repeat(200) })).not.toBeNull();
    expect(parse({ type: 'ready', worker: 'w'.repeat(201) })).toBeNull();
    expect(parse({ type: 'error', id: 1, message: 'e'.repeat(2_000) })).not.toBeNull();
    expect(parse({ type: 'error', id: 1, message: 'e'.repeat(2_001) })).toBeNull();
  });
});
