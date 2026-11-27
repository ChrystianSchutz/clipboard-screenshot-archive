import { describe, expect, it } from 'vitest';
import {
  batches,
  compareOrder,
  copiedMessage,
  copiedTextMessage,
  selectionFacts,
  selectionMenuContext,
  textClips,
} from './selection-actions';
import { clipSummary as summary, source } from './test-fixtures';

describe('selectionFacts', () => {
  it('counts kinds in the fixed kind order, text, images and pins', () => {
    const facts = selectionFacts([
      summary({ id: 1, kind: 'url', pinned: true }),
      summary({ id: 2, kind: 'image' }),
      summary({ id: 3, kind: 'json' }),
      summary({ id: 4, kind: 'url' }),
    ]);
    expect(facts.count).toBe(4);
    expect(facts.textCount).toBe(3);
    expect(facts.imageCount).toBe(1);
    expect(facts.pinnedCount).toBe(1);
    expect(facts.kinds).toEqual([
      { kind: 'json', count: 1 },
      { kind: 'url', count: 2 },
      { kind: 'image', count: 1 },
    ]);
  });

  it('lists the source apps by frequency, leaves out unknown ones, and spans the copy times', () => {
    const facts = selectionFacts([
      summary({ id: 1, lastCopiedAt: 500, source: source('Slack') }),
      summary({ id: 2, lastCopiedAt: 900, source: source('Code') }),
      summary({ id: 3, lastCopiedAt: 700, source: source('Slack') }),
      summary({ id: 4, lastCopiedAt: 800, source: source(null) }),
    ]);
    expect(facts.apps).toEqual(['Slack', 'Code']);
    expect(facts.oldest).toBe(500);
    expect(facts.newest).toBe(900);
  });

  it('is empty for no clips', () => {
    const facts = selectionFacts([]);
    expect(facts).toMatchObject({ count: 0, textCount: 0, kinds: [], oldest: null, newest: null });
  });
});

describe('compareOrder', () => {
  it('puts the older clip on side A, whatever the selection order', () => {
    const older = summary({ id: 7, lastCopiedAt: 100 });
    const newer = summary({ id: 3, lastCopiedAt: 200 });
    expect(compareOrder([newer, older])).toEqual([7, 3]);
    expect(compareOrder([older, newer])).toEqual([7, 3]);
  });

  it('breaks a tie on the copy time by id, as the list does', () => {
    expect(
      compareOrder([summary({ id: 9, lastCopiedAt: 5 }), summary({ id: 4, lastCopiedAt: 5 })]),
    ).toEqual([4, 9]);
  });

  it('is null unless exactly two text clips are selected', () => {
    expect(compareOrder([summary({ id: 1 })])).toBeNull();
    expect(compareOrder([summary({ id: 1 }), summary({ id: 2 }), summary({ id: 3 })])).toBeNull();
    expect(compareOrder([summary({ id: 1 }), summary({ id: 2, kind: 'image' })])).toBeNull();
  });
});

describe('selectionMenuContext', () => {
  it('describes a selection for the menu and the summary pane', () => {
    const clips = [summary({ id: 1, pinned: true }), summary({ id: 2, pinned: true })];
    expect(selectionMenuContext(clips, { noun: 'clip', copyText: false, compare: true })).toEqual({
      noun: 'clip',
      count: 2,
      textCount: 2,
      allPinned: true,
      copyText: false,
      compare: true,
    });
  });

  it('reports compare as unavailable for other selections, and as not offered when off', () => {
    const three = [summary({ id: 1 }), summary({ id: 2 }), summary({ id: 3, pinned: true })];
    const context = selectionMenuContext(three, { noun: 'clip', copyText: false, compare: true });
    expect(context.compare).toBe(false);
    expect(context.allPinned).toBe(false);
    expect(
      selectionMenuContext(three, { noun: 'screenshot', copyText: true, compare: false }).compare,
    ).toBeNull();
  });
});

describe('copy helpers', () => {
  it('keeps the text clips in order', () => {
    const clips = [summary({ id: 1 }), summary({ id: 2, kind: 'image' }), summary({ id: 3 })];
    expect(textClips(clips).map((clip) => clip.id)).toEqual([1, 3]);
  });

  it('words the toasts with counts', () => {
    expect(copiedMessage(3, 0)).toBe('Copied 3 clips');
    expect(copiedMessage(3, 1)).toBe('Copied 3 clips, 1 image skipped');
    expect(copiedMessage(1, 2)).toBe('Copied 1 clip, 2 images skipped');
    expect(copiedTextMessage(2, 0)).toBe('Copied the text of 2 screenshots');
    expect(copiedTextMessage(2, 1)).toBe(
      'Copied the text of 2 screenshots, 1 without text skipped',
    );
  });
});

describe('batches', () => {
  it('splits ids into IPC-sized batches', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([1, 2], 500)).toEqual([[1, 2]]);
    expect(batches([], 500)).toEqual([]);
  });
});
