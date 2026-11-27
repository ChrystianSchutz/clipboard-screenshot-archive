/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { clipMenuItems, selectionMenuItems } from './context-menu';
import { ContextMenu, type ContextMenuProps } from './ContextMenu';

function renderMenu(overrides: Partial<ContextMenuProps> = {}) {
  const props: ContextMenuProps = {
    entries: clipMenuItems({ kind: 'text', pinned: false, hasOcrText: false, compare: 'mark' }),
    position: { x: 40, y: 50 },
    label: 'Clip actions',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const onParentKeyDown = vi.fn();
  const view = render(
    <div onKeyDown={onParentKeyDown}>
      <button type="button">outside</button>
      <ContextMenu {...props} />
    </div>,
  );
  return {
    ...view,
    props,
    onParentKeyDown,
    menu: screen.getByRole('menu', { name: props.label }),
  };
}

const item = (name: string) => screen.getByRole('menuitem', { name });
const focusedName = () =>
  document.activeElement?.querySelector('.context-menu__label')?.textContent;

describe('ContextMenu', () => {
  it('renders the items in order with their shortcuts, and a separator before Delete', () => {
    const { menu } = renderMenu();
    expect(screen.getAllByRole('menuitem').map((element) => element.dataset.id)).toEqual([
      'copy',
      'pin',
      'compare',
      'delete',
    ]);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(item('Copy').textContent).toContain('Enter');
    expect(item('Pin').getAttribute('aria-keyshortcuts')).toBe('Control+P');
    expect(item('Delete').getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(item('Delete').className).toContain('context-menu__item--danger');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
  });

  it('moves focus into the menu, onto the first item', () => {
    renderMenu();
    expect(document.activeElement).toBe(item('Copy'));
  });

  it('moves between items with the arrows, wrapping, and Home/End', () => {
    const { menu } = renderMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focusedName()).toBe('Pin');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(focusedName()).toBe('Delete');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focusedName()).toBe('Copy');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(focusedName()).toBe('Delete');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(focusedName()).toBe('Copy');
  });

  it('picks the focused item with Enter, and an item with a click', () => {
    const { menu, props } = renderMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(props.onSelect).toHaveBeenLastCalledWith('pin');
    fireEvent.click(item('Delete'));
    expect(props.onSelect).toHaveBeenLastCalledWith('delete');
  });

  it('keeps its keys from the view under it, so Enter or Delete never act on the list too', () => {
    const { menu, onParentKeyDown } = renderMenu();
    for (const key of ['Enter', 'Delete', 'ArrowDown', 'Escape', 'p']) {
      fireEvent.keyDown(menu, { key });
    }
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('closes with Escape and Tab, asking to give focus back', () => {
    const { menu, props } = renderMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(props.onClose).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on a click outside, the wheel, a resize or the window losing focus', () => {
    const { props } = renderMenu();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(props.onClose).toHaveBeenLastCalledWith(false);
    fireEvent.wheel(document.body);
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('blur'));
    expect(props.onClose).toHaveBeenCalledTimes(4);
  });

  it('stays open for clicks and the wheel inside it', () => {
    const { props } = renderMenu();
    fireEvent.pointerDown(item('Pin'));
    fireEvent.wheel(item('Pin'));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps itself inside the window', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 150,
    } as DOMRect);
    const { menu } = renderMenu({ position: { x: window.innerWidth - 10, y: window.innerHeight } });
    expect(menu.style.left).toBe(`${String(window.innerWidth - 204)}px`);
    expect(menu.style.top).toBe(`${String(window.innerHeight - 154)}px`);
  });
});

describe('ContextMenu with a disabled item', () => {
  const entries = selectionMenuItems({
    noun: 'screenshot',
    count: 2,
    textCount: 0,
    allPinned: false,
    copyText: true,
    compare: null,
  });

  it('shows it, keeps it reachable, and says why it is unavailable', () => {
    renderMenu({ entries, label: 'Actions for 2 screenshots' });
    const copy = item('Copy');
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    expect(copy.title).toBe('Several images cannot be copied at once. Use Copy text.');
    // Still the first stop for the arrow keys, so the reason can be read.
    expect(document.activeElement).toBe(copy);
  });

  it('ignores clicks, Enter and Space on it, but runs the other items', () => {
    const { props, menu } = renderMenu({ entries, label: 'Actions for 2 screenshots' });
    fireEvent.click(item('Copy'));
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.keyDown(menu, { key: ' ' });
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.click(item('Copy text of 2 screenshots'));
    expect(props.onSelect).toHaveBeenCalledWith('copy-text');
  });
});
