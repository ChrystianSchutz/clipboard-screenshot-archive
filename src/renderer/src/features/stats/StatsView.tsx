import { useEffect, useState, type ReactNode } from 'react';
import { CATEGORY_LABELS } from '@shared/categories';
import type { ClipKind, CountBy, HistoryStats } from '@shared/types';
import { compactNumber } from '@shared/text';
import { api } from '../../api';
import { EmptyState, Segmented, kindLabel } from '../../components/primitives';
import { dayLong, hourRange, peak, percentages, weekdayShort } from './chart-data';
import { ColumnChart, type Column } from './ColumnChart';
import './stats.css';

type Mode = 'chart' | 'table';
const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
];

export function StatsView() {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [mode, setMode] = useState<Mode>('chart');

  useEffect(() => {
    const load = (): void => {
      api.stats.get().then(setStats, () => undefined);
    };
    load();
    return api.history.onChanged(load);
  }, []);

  if (!stats) return null;
  if (stats.totalCopies === 0) {
    return (
      <EmptyState title="No statistics yet">
        <p>Copy a few things and come back: charts fill in as your trail grows.</p>
      </EmptyState>
    );
  }

  // `byDay` ends with today (computed in main with the stats), so no clock read during render.
  const today = stats.byDay.at(-1)?.key;
  const days: Column[] = stats.byDay.map((day) => ({
    key: day.key,
    label: day.key === today ? 'Today' : weekdayShort(day.key),
    title: dayLong(day.key),
    value: day.count,
    emphasis: day.key === today,
  }));
  const hours: Column[] = stats.byHour.map((hour) => ({
    key: String(hour.key),
    label: hour.key % 6 === 0 ? String(hour.key).padStart(2, '0') : '',
    title: hourRange(hour.key),
    value: hour.count,
  }));
  const busiestHour = peak(stats.byHour);
  const busiestDay = peak(stats.byDay);

  return (
    <div className="stats">
      <section className="kpis" aria-label="Totals">
        <Kpi label="Copies today" value={stats.copiesToday} />
        <Kpi label="Copies" value={stats.totalCopies} />
        <Kpi label="Unique clips" value={stats.totalClips} />
        <Kpi label="Pinned" value={stats.pinnedClips} />
        <Kpi label="Characters kept" value={stats.totalChars} />
      </section>

      <div className="stats__toolbar">
        <Segmented label="Display" value={mode} options={MODES} onChange={setMode} />
      </div>

      <div className="stats__grid">
        <Card
          title="Copies, last 14 days"
          note={busiestDay ? `Busiest: ${dayLong(busiestDay.key)}` : undefined}
          wide
        >
          {mode === 'chart' ? (
            <ColumnChart columns={days} unit="copies" ariaLabel="Copies per day, last 14 days" />
          ) : (
            <CountTable header={['Day', 'Copies']} rows={days.map((d) => [d.title, d.value])} />
          )}
        </Card>

        <Card
          title="By hour of day"
          note={busiestHour ? `Peak: ${hourRange(busiestHour.key)}` : undefined}
          wide
        >
          {mode === 'chart' ? (
            <ColumnChart
              columns={hours}
              unit="copies"
              ariaLabel="Copies by hour of day"
              height={90}
            />
          ) : (
            <CountTable header={['Hour', 'Copies']} rows={hours.map((h) => [h.title, h.value])} />
          )}
        </Card>

        <Card title="Top apps">
          <RankedBars items={stats.topApps} empty="No source apps detected yet" mode={mode} />
        </Card>

        <Card title="Top sites">
          <RankedBars items={stats.topDomains} empty="No pages detected yet" mode={mode} />
        </Card>

        <Card title="Top categories">
          <RankedBars
            items={stats.byCategory.map((entry) => ({
              key: CATEGORY_LABELS[entry.key],
              count: entry.count,
            }))}
            empty="No categories detected yet"
            mode={mode}
            unit="clips"
          />
        </Card>

        <Card title="Content kinds">
          <KindBreakdown kinds={stats.byKind} mode={mode} />
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="kpi">
      <div className="kpi__value" title={value.toLocaleString('en-US')}>
        {compactNumber(value)}
      </div>
      <div className="kpi__label">{label}</div>
    </div>
  );
}

function Card({
  title,
  note,
  wide = false,
  children,
}: {
  title: string;
  note?: string | undefined;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card ${wide ? 'card--wide' : ''}`} aria-label={title}>
      <header className="card__header">
        <h3>{title}</h3>
        {note && <span>{note}</span>}
      </header>
      {children}
    </section>
  );
}

function CountTable({ header, rows }: { header: [string, string]; rows: [string, number][] }) {
  return (
    <table className="count-table">
      <thead>
        <tr>
          <th scope="col">{header[0]}</th>
          <th scope="col">{header[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{value.toLocaleString('en-US')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal bars with the label and value as text: identity never depends on color. */
function RankedBars({
  items,
  empty,
  mode,
  unit = 'copies',
}: {
  items: readonly CountBy[];
  empty: string;
  mode: Mode;
  /** What `count` counts, plural and lower-case ("copies", "clips"). */
  unit?: string;
}) {
  if (items.length === 0) return <p className="card__empty">{empty}</p>;
  if (mode === 'table') {
    const header = unit.charAt(0).toUpperCase() + unit.slice(1);
    return (
      <CountTable header={['Name', header]} rows={items.map((item) => [item.key, item.count])} />
    );
  }
  const max = Math.max(...items.map((item) => item.count));
  return (
    <ol className="ranked">
      {items.map((item) => (
        <li
          key={item.key}
          className="ranked__row"
          title={`${item.key}: ${item.count.toLocaleString('en-US')} ${unit}`}
        >
          <span className="ranked__label">{item.key}</span>
          <span className="ranked__value">{item.count.toLocaleString('en-US')}</span>
          <span className="ranked__track" aria-hidden>
            <span
              className="ranked__bar"
              style={{ width: `${String((item.count / max) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One segmented bar (2px surface gaps between segments) plus a labelled legend. */
function KindBreakdown({ kinds: all, mode }: { kinds: readonly CountBy<ClipKind>[]; mode: Mode }) {
  // A kind nobody copied is noise in the legend ("Code 0 · 0%").
  const kinds = all.filter((kind) => kind.count > 0);
  const shares = percentages(kinds.map((kind) => kind.count));
  if (mode === 'table') {
    return (
      <CountTable
        header={['Kind', 'Clips']}
        rows={kinds.map((kind, index) => [
          `${kindLabel(kind.key)} (${String(shares[index] ?? 0)}%)`,
          kind.count,
        ])}
      />
    );
  }
  return (
    <div className="kinds">
      <div className="kinds__bar" role="img" aria-label="Share of clips by kind">
        {kinds
          .filter((kind) => kind.count > 0)
          .map((kind) => (
            <span
              key={kind.key}
              className={`kinds__segment kinds__segment--${kind.key}`}
              style={{ flexGrow: kind.count }}
              title={`${kindLabel(kind.key)}: ${kind.count.toLocaleString('en-US')} clips`}
            />
          ))}
      </div>
      <ul className="kinds__legend">
        {kinds.map((kind, index) => (
          <li key={kind.key}>
            <span className={`kinds__swatch kinds__segment--${kind.key}`} aria-hidden />
            {kindLabel(kind.key)}
            <span className="kinds__count">
              {kind.count.toLocaleString('en-US')} · {shares[index] ?? 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
