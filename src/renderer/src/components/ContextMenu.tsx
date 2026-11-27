import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  clampMenuPosition,
  isMenuNavKey,
  isSeparator,
  nextMenuIndex,
  type MenuEntry,
  type Point,
} from './context-menu';
import './context-menu.css';

export interface ContextMenuProps {
  readonly entries: readonly MenuEntry[];
  /** Where the menu opens, in window (client) coordinates; it is moved to stay inside the window. */
  readonly position: Point;
  /** Accessible name of the menu, e.g. "Clip actions". */
  readonly label: string;
  readonly onSelect: (id: string) => void;
  /**
   * Called when the menu should close. `restoreFocus` is true when it closes from inside (Escape,
   * Tab), false when the user went elsewhere (a click outside, scrolling, the window losing focus).
   */
  readonly onClose: (restoreFocus: boolean) => void;
}

/**
 * A right-click menu in the VS Code style: rendered in the page (themable, testable headless), not
 * a native menu. Focus moves to its first item; arrows, Home/End, Enter and Escape work as in a
 * native menu. Keys never reach the view under it, so Enter or Delete cannot act on the list too.
 */
export function ContextMenu({ entries, position, label, onSelect, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Place it before the first paint: measure, then keep it inside the window.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const placed = clampMenuPosition(
      position,
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${String(placed.x)}px`;
    menu.style.top = `${String(placed.y)}px`;
  }, [position, entries]);

  // Focus the first item when it opens (and again when it is reopened somewhere else).
  useLayoutEffect(() => {
    menuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    const close = (): void => onCloseRef.current(false);
    const outside = (event: Event): boolean =>
      !(event.target instanceof Node && menuRef.current?.contains(event.target));
    const onPointerDown = (event: PointerEvent): void => {
      if (outside(event)) close();
    };
    const onWheel = (event: WheelEvent): void => {
      if (outside(event)) close();
    };
    const onScroll = (event: Event): void => {
      if (outside(event)) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    // Opening selects the clip, and the list then scrolls it into view; that scroll is ours, not
    // the user's. Listen for scrolling only once those frames have passed (the wheel closes at once).
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        window.addEventListener('scroll', onScroll, true);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The menu owns the keyboard while it is open: nothing reaches the list's shortcuts.
    event.stopPropagation();
    const items = menuItems(menuRef.current);
    const current = items.findIndex((item) => item === document.activeElement);
    if (isMenuNavKey(event.key)) {
      event.preventDefault();
      items[nextMenuIndex(items.length, current, event.key)]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const id = items[current]?.dataset.id;
      if (id !== undefined) onSelect(id);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose(true);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
    }
  };

  const swallow = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={swallow}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {entries.map((entry, index) =>
        isSeparator(entry) ? (
          <div
            key={`separator-${String(index)}`}
            className="context-menu__separator"
            role="separator"
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-id={entry.id}
            aria-keyshortcuts={entry.hint ? ariaKeys(entry.hint) : undefined}
            className={`context-menu__item ${entry.danger ? 'context-menu__item--danger' : ''}`}
            onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
            onClick={() => onSelect(entry.id)}
          >
            <span className="context-menu__label">{entry.label}</span>
            {entry.hint && (
              <span className="context-menu__hint" aria-hidden="true">
                {entry.hint}
              </span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** "Ctrl+P" → "Control+P", "Del" → "Delete": the hint in `aria-keyshortcuts` syntax. */
function ariaKeys(hint: string): string {
  return hint.replace(/\bCtrl\b/, 'Control').replace(/^Del$/, 'Delete');
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}
