/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClipSummary } from '@shared/types';
import {
  ClipContextMenu,
  isStaleSelectionMenu,
  type ClipMenuControls,
  type ClipMenuHandlers,
  type ClipMenuState,
} from './ClipContextMenu';
import { clipSummary } from './test-fixtures';

const SHOWN: readonly ClipSummary[] = [
  clipSummary({ id: 3 }),
  clipSummary({ id: 2 }),
  clipSummary({ id: 1 }),
];

function menuOn(targets: readonly ClipSummary[]): ClipMenuState {
  const [clip] = targets;
  if (!clip) throw new Error('no clip');
  return { clip, targets, position: { x: 10, y: 10 }, ocrText: '' };
}

function setup(selectedIds: readonly number[]) {
  const close = vi.fn<(restoreFocus: boolean) => void>();
  const controls: ClipMenuControls = {
    menu: menuOn(SHOWN),
    openAtPointer: vi.fn(),
    openAtElement: vi.fn(),
    close,
  };
  const selection = {
    noun: 'clip' as const,
    copy: vi.fn(),
    togglePin: vi.fn(),
    compare: vi.fn(),
    remove: vi.fn(),
  };
  const handlers: ClipMenuHandlers = {
    copy: vi.fn(),
    togglePin: vi.fn(),
    remove: vi.fn(),
    selection,
  };
  const view = (ids: readonly number[]) => (
    <ClipContextMenu controls={controls} handlers={handlers} selectedIds={ids} onNotify={vi.fn()} />
  );
  const { rerender } = render(view(selectedIds));
  return { close, selection, rerender: (ids: readonly number[]) => rerender(view(ids)) };
}

describe('isStaleSelectionMenu', () => {
  it('flags a selection menu whose clips are no longer exactly the selection', () => {
    expect(isStaleSelectionMenu(menuOn(SHOWN), [3, 2, 1])).toBe(false);
    expect(isStaleSelectionMenu(menuOn(SHOWN), [3, 2])).toBe(true);
    expect(isStaleSelectionMenu(menuOn(SHOWN), [3, 2, 1, 0])).toBe(true);
    expect(isStaleSelectionMenu(menuOn(SHOWN), [3, 1, 2])).toBe(true);
  });

  it('leaves a closed menu and a one-clip menu alone', () => {
    expect(isStaleSelectionMenu(null, [])).toBe(false);
    expect(isStaleSelectionMenu(menuOn(SHOWN.slice(0, 1)), [7])).toBe(false);
  });
});

describe('ClipContextMenu on a selection', () => {
  it('runs the action on exactly the clips it showed', () => {
    const { selection, close } = setup([3, 2, 1]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin 3 clips' }));

    expect(close).toHaveBeenCalledWith(true);
    expect(selection.togglePin).toHaveBeenCalledExactlyOnceWith(SHOWN);
  });

  it('closes, and shows nothing, once the selection changes under it', () => {
    const { close, selection, rerender } = setup([3, 2, 1]);
    expect(screen.getByRole('menu', { name: 'Actions for 3 clips' })).toBeTruthy();

    // A refresh dropped one of the clips: "Pin 3 clips" would now pin two.
    rerender([3, 2]);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
    expect(selection.togglePin).not.toHaveBeenCalled();
  });
});
