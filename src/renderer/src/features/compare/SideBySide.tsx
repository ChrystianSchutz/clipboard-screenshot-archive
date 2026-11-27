import { useMemo, useState } from 'react';
import type { DiffCell, DiffRow } from '@shared/text-diff';
import { pluralize } from '@shared/text';
import { foldUnchanged } from './comparison';

function Cell({
  cell,
  side,
  type,
}: {
  cell: DiffCell | null;
  side: 'left' | 'right';
  type: DiffRow['type'];
}) {
  const tone =
    cell === null ? 'empty' : type === 'same' ? 'same' : side === 'left' ? 'removed' : 'added';
  return (
    <>
      <td className={`sbs__num sbs__num--${tone}`}>{cell?.lineNo ?? ''}</td>
      <td className={`sbs__code sbs__code--${tone}`}>
        {cell?.segments.map((segment, index) =>
          segment.changed ? (
            <span
              key={index}
              className={`sbs__word sbs__word--${side === 'left' ? 'removed' : 'added'}`}
            >
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
      </td>
    </>
  );
}

/** Two-column diff with line numbers, word-level highlights and folded unchanged runs. */
export function SideBySide({ rows }: { readonly rows: readonly DiffRow[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const display = useMemo(() => foldUnchanged(rows, 3, expanded), [rows, expanded]);

  return (
    <div className="sbs" role="region" aria-label="Side by side diff" tabIndex={0}>
      <table className="sbs__table mono">
        <colgroup>
          <col className="sbs__col-num" />
          <col />
          <col className="sbs__col-num" />
          <col />
        </colgroup>
        <tbody>
          {display.map((item) =>
            item.kind === 'gap' ? (
              <tr key={`gap-${String(item.start)}`} className="sbs__gap">
                <td colSpan={4}>
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => new Set(current).add(item.start))}
                  >
                    ⋯ {pluralize(item.count, 'unchanged line')}
                  </button>
                </td>
              </tr>
            ) : (
              <tr
                key={`${String(item.row.left?.lineNo ?? 'x')}-${String(item.row.right?.lineNo ?? 'x')}`}
              >
                <Cell cell={item.row.left} side="left" type={item.row.type} />
                <Cell cell={item.row.right} side="right" type={item.row.type} />
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
