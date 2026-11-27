import { useId, useState } from 'react';
import { niceCeil } from './chart-data';

export interface Column {
  readonly key: string;
  /** Axis label under the column; empty string hides it (for dense axes). */
  readonly label: string;
  /** Full description for the tooltip and the table view. */
  readonly title: string;
  readonly value: number;
  readonly emphasis?: boolean;
}

interface ColumnChartProps {
  readonly columns: readonly Column[];
  readonly unit: string;
  readonly ariaLabel: string;
  readonly height?: number;
}

/**
 * Single-series column chart in plain HTML. One hue (magnitude), thin columns with 4px rounded
 * data ends on the baseline, a 2px gap, a recessive axis, and a tooltip per column whose hit
 * target spans the full plot height.
 */
export function ColumnChart({ columns, unit, ariaLabel, height = 120 }: ColumnChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const tooltipId = useId();
  const max = niceCeil(Math.max(0, ...columns.map((column) => column.value)));
  const hovered = hover === null ? undefined : columns[hover];

  return (
    <figure className="columns" aria-label={ariaLabel}>
      <div className="columns__plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        <span className="columns__max" aria-hidden>
          {max.toLocaleString('en-US')}
        </span>
        <div className="columns__grid" aria-hidden />
        {columns.map((column, index) => (
          <div
            key={column.key}
            className={`columns__slot ${hover === index ? 'columns__slot--hover' : ''}`}
            onMouseEnter={() => setHover(index)}
            aria-describedby={hover === index ? tooltipId : undefined}
          >
            <div
              className={`columns__bar ${column.emphasis ? 'columns__bar--emphasis' : ''} ${column.value === 0 ? 'columns__bar--zero' : ''}`}
              style={{ height: `${String((column.value / max) * 100)}%` }}
            />
          </div>
        ))}
        {hovered && hover !== null && (
          <div
            id={tooltipId}
            role="tooltip"
            className="chart-tooltip"
            style={{ left: `${String(((hover + 0.5) / columns.length) * 100)}%` }}
          >
            <strong>{hovered.value.toLocaleString('en-US')}</strong> {unit}
            <span>{hovered.title}</span>
          </div>
        )}
      </div>
      <div className="columns__axis" aria-hidden>
        {columns.map((column) => (
          <span key={column.key}>{column.label}</span>
        ))}
      </div>
    </figure>
  );
}
