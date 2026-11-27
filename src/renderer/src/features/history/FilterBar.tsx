import { forwardRef } from 'react';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '@shared/categories';
import type { OperatorKey } from '@shared/search-query';
import { CLIP_KINDS, type ClipKind, type TimeRange } from '@shared/types';
import { Icon } from '../../components/Icon';
import { Segmented, kindLabel } from '../../components/primitives';
import type { ActiveOperator } from './search-operators';
import type { HistoryFilters } from './useHistory';
import './search-operators.css';

interface FilterBarProps {
  /** The controls' own state (the search text as typed, operators included). */
  readonly filters: HistoryFilters;
  /** Operators typed in the search box; each one overrides (and locks) its control. */
  readonly operators: readonly ActiveOperator[];
  readonly apps: readonly string[];
  readonly error: string | null;
  readonly onChange: (patch: Partial<HistoryFilters>) => void;
  readonly onRemoveOperator: (key: OperatorKey) => void;
}

const RANGES: readonly { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

const OPERATOR_PREFIX: Record<OperatorKey, string> = {
  category: '#',
  app: 'app:',
  kind: 'kind:',
  pinned: 'is:',
};

/** Tooltip for a control whose value currently comes from the search box. */
const lockedBy = (operator: ActiveOperator | undefined): string | undefined =>
  operator ? `Set by ${OPERATOR_PREFIX[operator.key]} in the search box` : undefined;

export const FilterBar = forwardRef<HTMLInputElement, FilterBarProps>(function FilterBar(
  { filters, operators, apps, error, onChange, onRemoveOperator },
  searchRef,
) {
  const operator = (key: OperatorKey): ActiveOperator | undefined =>
    operators.find((candidate) => candidate.key === key);
  const appOperator = operator('app');
  const kindOperator = operator('kind');
  const categoryOperator = operator('category');
  const pinnedOperator = operator('pinned');

  return (
    <div className="filters">
      <div className={`search ${error ? 'search--invalid' : ''}`}>
        <Icon name="search" />
        <input
          ref={searchRef}
          type="search"
          className={filters.regex ? 'mono' : undefined}
          placeholder={
            filters.regex
              ? 'Regular expression, e.g. timeout\\s*=\\s*\\d+'
              : 'Search text, URL or app…  try #sql, app:chrome, is:pinned'
          }
          aria-label="Search history"
          aria-invalid={error !== null}
          aria-describedby={error ? 'search-error' : undefined}
          value={filters.text}
          spellCheck={false}
          autoFocus
          onChange={(event) => onChange({ text: event.target.value })}
        />
        <button
          type="button"
          className="button button--ghost button--icon mono"
          aria-pressed={filters.regex}
          title="Regular expression (Ctrl+R)"
          aria-label="Regular expression"
          onClick={() => onChange({ regex: !filters.regex })}
        >
          .*
        </button>
      </div>
      {error && (
        <div id="search-error" className="search-error" role="status">
          {error}
        </div>
      )}
      {operators.length > 0 && (
        <ul className="operators" aria-label="Active search operators">
          {operators.map((op) => (
            <li
              key={op.key}
              className={`operator ${op.resolved ? '' : 'operator--unresolved'}`}
              title={op.description}
            >
              <span className="operator__key">{OPERATOR_PREFIX[op.key]}</span>
              <span className="operator__value">{op.label}</span>
              <button
                type="button"
                className="operator__remove"
                aria-label={`Remove ${op.description}`}
                onClick={() => onRemoveOperator(op.key)}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="filters__row">
        <select
          className="select"
          aria-label="Source app"
          disabled={appOperator !== undefined}
          title={lockedBy(appOperator)}
          value={appOperator ? '' : (filters.app ?? '')}
          onChange={(event) =>
            onChange({ app: event.target.value === '' ? null : event.target.value })
          }
        >
          <option value="">{appOperator ? `App: ${appOperator.label}` : 'All apps'}</option>
          {apps.map((app) => (
            <option key={app} value={app}>
              {app}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Content kind"
          disabled={kindOperator !== undefined}
          title={lockedBy(kindOperator)}
          value={kindOperator ? '' : (filters.kind ?? '')}
          onChange={(event) =>
            onChange({ kind: event.target.value === '' ? null : (event.target.value as ClipKind) })
          }
        >
          <option value="">{kindOperator ? `Kind: ${kindOperator.label}` : 'Any kind'}</option>
          {CLIP_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(kind)}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Category"
          disabled={categoryOperator !== undefined}
          title={lockedBy(categoryOperator)}
          value={categoryOperator ? '' : (filters.category ?? '')}
          onChange={(event) =>
            onChange({
              category: event.target.value === '' ? null : (event.target.value as Category),
            })
          }
        >
          <option value="">
            {categoryOperator ? `Category: ${categoryOperator.label}` : 'Any category'}
          </option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
        <Segmented
          label="Time range"
          value={filters.range}
          options={RANGES}
          onChange={(range) => onChange({ range })}
        />
        <button
          type="button"
          className="button"
          aria-pressed={filters.pinnedOnly || pinnedOperator !== undefined}
          disabled={pinnedOperator !== undefined}
          title={lockedBy(pinnedOperator)}
          onClick={() => onChange({ pinnedOnly: !filters.pinnedOnly })}
        >
          <Icon name="pin" size={14} /> Pinned
        </button>
      </div>
    </div>
  );
});
