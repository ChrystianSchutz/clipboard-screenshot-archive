/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClipSummary } from '@shared/types';
import { SelectionCount, SelectionSummary, type SelectionSummaryProps } from './SelectionSummary';
import { clipSummary, source } from './test-fixtures';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const CLIPS: readonly ClipSummary[] = [
  clipSummary({ id: 3, kind: 'url', lastCopiedAt: NOW - 2 * MINUTE, source: source('Chrome') }),
  clipSummary({ id: 2, kind: 'text', lastCopiedAt: NOW - 5 * MINUTE, pinned: true }),
  clipSummary({ id: 1, kind: 'image', lastCopiedAt: NOW - 9 * MINUTE, source: source(null) }),
];

function renderSummary(overrides: Partial<SelectionSummaryProps> = {}) {
  const props: SelectionSummaryProps = {
    clips: CLIPS,
    noun: 'clip',
    now: NOW,
    confirmingDelete: false,
    onCopy: vi.fn(),
    onTogglePin: vi.fn(),
    onCompare: vi.fn(),
    onDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    ...overrides,
  };
  render(<SelectionSummary {...props} />);
  return { props, pane: screen.getByRole('region', { name: 'Selected clips' }) };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('SelectionSummary', () => {
  it('sums up the selection: count, kinds, pins, sources and when', () => {
    const { pane } = renderSummary();
    expect(within(pane).getByRole('heading').textContent).toBe('3 clips selected');
    const kinds = within(pane).getByRole('list', { name: 'Kinds' });
    expect(
      within(kinds)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['URL1', 'Text1', 'Image1']);
    expect(pane.textContent).toContain('Pinned1 of 3');
    expect(pane.textContent).toContain('SourcesChrome, Code');
    expect(pane.textContent).toContain('Copied2 min ago to 9 min ago');
  });

  it('labels the actions with counts and skips images when copying', () => {
    renderSummary();
    const copy = button(/^Copy 2 clips/);
    expect(copy.title).toBe('1 image will be skipped');
    expect(copy.getAttribute('aria-disabled')).toBeNull();
    expect(button('Pin all').getAttribute('aria-pressed')).toBe('false');
    expect(button('Delete 3 clips').textContent).toBe(' Delete');
  });

  it('lists the selected items by name, and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      clipSummary({ id: 20 - index, preview: `item ${String(index)}\nsecond line` }),
    );
    renderSummary({ clips: many });
    const items = screen.getByRole('list', { name: 'Selected clips' });
    expect(
      within(items)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['item 0', 'item 1', 'item 2', 'item 3', 'item 4', 'item 5', 'and 2 more clips']);
  });

  it('runs the actions', () => {
    const { props } = renderSummary();
    fireEvent.click(button(/^Copy 2 clips/));
    fireEvent.click(button('Pin all'));
    fireEvent.click(button('Delete 3 clips'));
    expect(props.onCopy).toHaveBeenCalledOnce();
    expect(props.onTogglePin).toHaveBeenCalledOnce();
    expect(props.onDelete).toHaveBeenCalledOnce();
  });

  it('offers Unpin all when everything is pinned', () => {
    renderSummary({ clips: CLIPS.map((clip) => ({ ...clip, pinned: true })) });
    expect(button('Unpin all').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps Compare visible but unavailable unless exactly two text clips are selected', () => {
    const { props } = renderSummary();
    const compare = button('Compare');
    expect(compare.getAttribute('aria-disabled')).toBe('true');
    expect(compare.title).toBe('Select exactly two text clips to compare');
    fireEvent.click(compare);
    expect(props.onCompare).not.toHaveBeenCalled();
  });

  it('compares two text clips', () => {
    const { props } = renderSummary({ clips: CLIPS.slice(0, 2) });
    const compare = button('Compare');
    expect(compare.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(compare);
    expect(props.onCompare).toHaveBeenCalledOnce();
  });

  it('asks to confirm a delete inline, as an alert with Delete and Cancel', () => {
    const { props } = renderSummary({ confirmingDelete: true });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Delete 3 clips?');
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(props.onDelete).toHaveBeenCalledOnce();
    expect(props.onCancelDelete).toHaveBeenCalledOnce();
  });

  it('shows no confirmation until asked', () => {
    renderSummary();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables Copy of screenshots, offers Copy text, and has no Compare in the gallery', () => {
    const shots = [clipSummary({ id: 5, kind: 'image' }), clipSummary({ id: 4, kind: 'image' })];
    const onCopyText = vi.fn();
    const { props } = renderSummary({
      clips: shots,
      noun: 'screenshot',
      onCompare: undefined,
      onCopyText,
    });
    expect(screen.getByRole('heading').textContent).toBe('2 screenshots selected');
    const copy = button('Copy');
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    expect(copy.title).toBe('Several images cannot be copied at once. Use Copy text.');
    fireEvent.click(copy);
    expect(props.onCopy).not.toHaveBeenCalled();
    fireEvent.click(button('Copy text'));
    expect(onCopyText).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
    expect(button('Delete 2 screenshots')).toBeTruthy();
  });
});

describe('SelectionCount', () => {
  it('is an always-present live region that shows the count from two items on', () => {
    const { rerender } = render(<SelectionCount count={1} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    rerender(<SelectionCount count={4} />);
    expect(status.textContent).toBe('·4 selected');
  });
});
