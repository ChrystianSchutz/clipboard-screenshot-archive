import { describe, expect, it, vi } from 'vitest';
import { loadMacPasteboardCounter, pasteboardCounter, type ObjcRuntime } from './pasteboard';

/** A fake Objective-C runtime with one pasteboard whose change count the test moves. */
function runtime(overrides: Partial<ObjcRuntime> = {}) {
  let changeCount = 41;
  const pasteboard = { name: 'general' };
  const fake = {
    getClass: vi.fn((name: string) => (name === 'NSPasteboard' ? { name } : null)),
    selector: vi.fn((name: string) => `sel:${name}`),
    sendForObject: vi.fn((_target: unknown, selector: unknown) =>
      selector === 'sel:generalPasteboard' ? pasteboard : null,
    ),
    sendForInteger: vi.fn((target: unknown, selector: unknown) =>
      target === pasteboard && selector === 'sel:changeCount' ? BigInt(changeCount) : 0,
    ),
  };
  return {
    fake: { ...fake, ...overrides },
    selector: fake.selector,
    copy: () => {
      changeCount++;
    },
  };
}

describe('pasteboardCounter', () => {
  it('reads NSPasteboard.generalPasteboard.changeCount and follows every write', () => {
    const { fake, copy, selector } = runtime();
    const counter = pasteboardCounter(fake);

    expect(counter?.()).toBe(41);
    copy();
    copy();
    expect(counter?.()).toBe(43);
    // The selectors are looked up once, not per read.
    expect(selector).toHaveBeenCalledTimes(2);
  });

  it('gives up when AppKit has no pasteboard class or no general pasteboard', () => {
    expect(pasteboardCounter(runtime({ getClass: () => null }).fake)).toBeNull();
    expect(pasteboardCounter(runtime({ sendForObject: () => null }).fake)).toBeNull();
  });

  it('gives up when the answer is not an integer', () => {
    expect(pasteboardCounter(runtime({ sendForInteger: () => Number.NaN }).fake)).toBeNull();
  });
});

describe('loadMacPasteboardCounter', () => {
  it('loads nothing off macOS', async () => {
    await expect(loadMacPasteboardCounter('win32')).resolves.toBeNull();
    await expect(loadMacPasteboardCounter('linux')).resolves.toBeNull();
  });
});
