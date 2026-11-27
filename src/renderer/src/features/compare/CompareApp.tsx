import { useEffect, useMemo, useState } from 'react';
import { displayAccelerator } from '@shared/accelerator';
import { firstLine, pluralize } from '@shared/text';
import { formatClock } from '@shared/time';
import type { CompareSide, CompareState } from '@shared/types';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { EmptyState, Kbd, Segmented } from '../../components/primitives';
import { useSettings } from '../../hooks/useSettings';
import { ChangeList } from './ChangeList';
import { compareTexts, type Comparison } from './comparison';
import { SideBySide } from './SideBySide';
import './compare.css';

type Tab = 'changes' | 'lines';

/** The always-on-top diff window: copy A, press the shortcut, copy B, press it again. */
export function CompareApp() {
  const [state, setState] = useState<CompareState | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [ignoreArrayOrder, setIgnoreArrayOrder] = useState(false);
  const [tab, setTab] = useState<Tab>('changes');
  const [platform, setPlatform] = useState('win32');
  const { settings } = useSettings();

  useEffect(() => {
    api.compare.getState().then(setState, () => undefined);
    api.app.info().then(
      (info) => setPlatform(info.platform),
      () => undefined,
    );
    return api.compare.onState((next) => {
      setState(next);
      setSwapped(false);
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void api.window.hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shortcut = settings ? displayAccelerator(settings.shortcuts.compare, platform) : '';

  const sides = useMemo(() => {
    if (state?.phase !== 'ready') return null;
    return swapped ? { a: state.right, b: state.left } : { a: state.left, b: state.right };
  }, [state, swapped]);

  const comparison = useMemo(
    () => (sides ? compareTexts(sides.a.content, sides.b.content, { ignoreArrayOrder }) : null),
    [sides, ignoreArrayOrder],
  );

  return (
    <div className="compare">
      <header className="compare__titlebar">
        <Icon name="compare" />
        <h1>Compare</h1>
        {comparison && <Summary comparison={comparison} />}
      </header>

      {state === null && (
        <EmptyState title="Compare two clipboard snapshots">
          <ol className="steps">
            <li>
              Copy the first text or JSON, press <Kbd>{shortcut}</Kbd>
            </li>
            <li>
              Copy the second one, press <Kbd>{shortcut}</Kbd> again
            </li>
          </ol>
          <p>Key order never counts as a difference. You can also pick two clips in the history.</p>
        </EmptyState>
      )}

      {state?.phase === 'waiting-for-b' && (
        <div className="waiting">
          <SideCard label="A" side={state.left} />
          <div className="waiting__next">
            <span className="waiting__pulse" aria-hidden />
            Now copy <strong>B</strong> and press <Kbd>{shortcut}</Kbd>
          </div>
          <button type="button" className="button" onClick={() => void api.compare.reset()}>
            Start over
          </button>
        </div>
      )}

      {sides && comparison && (
        <>
          <div className="compare__toolbar">
            <SideCard label="A" side={sides.a} />
            <button
              type="button"
              className="button button--icon"
              title="Swap A and B"
              aria-label="Swap A and B"
              onClick={() => setSwapped((value) => !value)}
            >
              <Icon name="swap" size={14} />
            </button>
            <SideCard label="B" side={sides.b} />
          </div>

          <div className="compare__controls">
            {comparison.mode === 'json' ? (
              <>
                <Segmented
                  label="View"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'changes', label: `Changes (${String(comparison.changes.length)})` },
                    { value: 'lines', label: 'Side by side' },
                  ]}
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={ignoreArrayOrder}
                    onChange={(event) => setIgnoreArrayOrder(event.target.checked)}
                  />
                  Ignore array order
                </label>
              </>
            ) : (
              <span className="compare__notice">
                {comparison.notice ?? 'Plain text: line-by-line comparison.'}
              </span>
            )}
            <span className="clip-row__spacer" />
            <button type="button" className="button" onClick={() => void api.compare.reset()}>
              New comparison
            </button>
          </div>

          <main className="compare__body">
            <Result comparison={comparison} tab={tab} />
          </main>
        </>
      )}
    </div>
  );
}

function SideCard({ label, side }: { label: string; side: CompareSide }) {
  return (
    <div className="side-card">
      <span className={`side-card__label side-card__label--${label.toLowerCase()}`}>{label}</span>
      <div className="side-card__text">
        <code>{firstLine(side.content, 80) || '(empty)'}</code>
        <span>
          {side.source.app ?? 'Unknown app'} · {formatClock(side.capturedAt)}
        </span>
      </div>
    </div>
  );
}

function Summary({ comparison }: { comparison: Comparison }) {
  if (comparison.mode === 'json') {
    const { added, removed, changed } = comparison.summary;
    if (added + removed + changed === 0) {
      return <span className="pill pill--same">Identical data</span>;
    }
    return (
      <span className="summary">
        {added > 0 && <span className="pill pill--added">+{added} added</span>}
        {removed > 0 && <span className="pill pill--removed">−{removed} removed</span>}
        {changed > 0 && <span className="pill pill--changed">~{changed} changed</span>}
      </span>
    );
  }
  const { addedLines, removedLines } = comparison.lines;
  if (addedLines + removedLines === 0)
    return <span className="pill pill--same">Identical text</span>;
  return (
    <span className="summary">
      <span className="pill pill--added">+{pluralize(addedLines, 'line')}</span>
      <span className="pill pill--removed">−{pluralize(removedLines, 'line')}</span>
    </span>
  );
}

function Result({ comparison, tab }: { comparison: Comparison; tab: Tab }) {
  if (comparison.mode === 'json' && comparison.changes.length === 0) {
    return (
      <EmptyState title="Same data">
        <p>
          {comparison.sameDataDifferentText
            ? 'The text differs only in key order or formatting. The JSON itself is identical.'
            : 'Both snapshots are exactly the same.'}
        </p>
      </EmptyState>
    );
  }
  if (comparison.mode === 'json' && tab === 'changes')
    return <ChangeList changes={comparison.changes} />;
  if (comparison.lines.rows.length === 0) return <EmptyState title="Both sides are empty" />;
  return <SideBySide rows={comparison.lines.rows} />;
}
