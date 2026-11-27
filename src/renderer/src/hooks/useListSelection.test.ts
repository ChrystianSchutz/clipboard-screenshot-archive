/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { selectAll, selectOnly, toggleItem } from '../lib/selection';
import { useListSelection } from './useListSelection';

function setup(initial: readonly number[]) {
  return renderHook(({ ids }: { ids: readonly number[] }) => useListSelection(ids), {
    initialProps: { ids: initial },
  });
}

describe('useListSelection', () => {
  it('selects the first item of a list as it loads', () => {
    const { result } = setup([30, 20, 10]);
    expect(result.current.selectedIds).toEqual([30]);
    expect(result.current.selection.focus).toBe(30);
  });

  it('drops items a filter hides, and does not bring them back when it is cleared', () => {
    const all = [30, 20, 10];
    const { result, rerender } = setup(all);
    act(() => result.current.update(selectAll));
    expect(result.current.selectedIds).toEqual([30, 20, 10]);

    rerender({ ids: [30, 10] });
    expect(result.current.selectedIds).toEqual([30, 10]);
    rerender({ ids: all });
    expect(result.current.selectedIds).toEqual([30, 10]);
  });

  it('keeps the selection when new items arrive on top', () => {
    const { result, rerender } = setup([30, 20, 10]);
    act(() => result.current.update((current) => toggleItem(current, 10)));
    rerender({ ids: [40, 30, 20, 10] });
    expect(result.current.selectedIds).toEqual([30, 10]);
    expect(result.current.selection.focus).toBe(10);
  });

  it('hands the visible ids to updates and keeps `update` stable across renders', () => {
    const { result, rerender } = setup([30, 20, 10]);
    const first = result.current.update;
    rerender({ ids: [20, 10] });
    expect(result.current.update).toBe(first);
    act(() => result.current.update(selectAll));
    expect(result.current.selectedIds).toEqual([20, 10]);
  });

  it('follows the top item as new items arrive, until the user picks one', () => {
    const { result, rerender } = setup([30, 20, 10]);
    rerender({ ids: [40, 30, 20, 10] });
    expect(result.current.selectedIds).toEqual([40]);

    act(() => result.current.update(() => selectOnly(30)));
    expect(result.current.selectedIds).toEqual([30]);
    rerender({ ids: [50, 40, 30, 20, 10] });
    expect(result.current.selectedIds).toEqual([30]);
  });

  it('falls back to following the top item once everything picked is gone', () => {
    const { result, rerender } = setup([30, 20, 10]);
    act(() => result.current.update(() => selectOnly(10)));
    rerender({ ids: [30, 20] });
    expect(result.current.selectedIds).toEqual([30]);
    rerender({ ids: [40, 30, 20] });
    expect(result.current.selectedIds).toEqual([40]);
  });

  it('compares ids by value, so an equal array rebuilt on every render does not loop', () => {
    const { result, rerender } = setup([30, 20, 10]);
    act(() => result.current.update((current) => toggleItem(current, 10)));
    const before = result.current.selection;
    rerender({ ids: [30, 20, 10] });
    rerender({ ids: [30, 20, 10] });
    expect(result.current.selection).toBe(before);
  });

  it('is empty for an empty list', () => {
    const { result, rerender } = setup([30]);
    rerender({ ids: [] });
    expect(result.current.selectedIds).toEqual([]);
    expect(result.current.selection.focus).toBeNull();
  });
});
