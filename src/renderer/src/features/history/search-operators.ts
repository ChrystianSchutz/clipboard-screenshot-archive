import { CATEGORY_LABELS } from '@shared/categories';
import { parseSearch, resolveApp, type OperatorKey } from '@shared/search-query';
import { kindLabel } from '../../components/primitives';
import type { HistoryFilters } from './useHistory';

/** One operator typed in the search box (`#sql`, `app:chrome`, `is:pinned`, `kind:json`). */
export interface ActiveOperator {
  readonly key: OperatorKey;
  /** Short text for the chip, e.g. "SQL" or "Chrome". */
  readonly label: string;
  /** `false` when the operator names something that does not exist (an unknown app). */
  readonly resolved: boolean;
  /** Longer explanation for the tooltip / accessible name. */
  readonly description: string;
}

export interface EffectiveSearch {
  /** What is actually queried: free text without the operators, operators merged in. */
  readonly filters: HistoryFilters;
  /** Operators found in the text, in a fixed order (category, app, kind, pinned). */
  readonly operators: readonly ActiveOperator[];
}

/**
 * Applies the search box mini-language (see `parseSearch`) on top of the filter controls.
 *
 * - An operator wins over the matching control, so what you type is what you get.
 * - `app:` is resolved against the apps in the history (`app:chrome` → "Chrome"). A name that
 *   matches no app is still applied as typed, so the list shows "No clips match" instead of
 *   silently ignoring it, and the chip is flagged as unresolved.
 * - Regex mode is left alone: there the whole text is the pattern.
 */
export function applySearchOperators(
  filters: HistoryFilters,
  apps: readonly string[],
): EffectiveSearch {
  if (filters.regex) return { filters, operators: [] };
  const parsed = parseSearch(filters.text);
  const operators: ActiveOperator[] = [];
  let next: HistoryFilters = { ...filters, text: parsed.text };

  if (parsed.category !== null) {
    const label = CATEGORY_LABELS[parsed.category];
    next = { ...next, category: parsed.category };
    operators.push({ key: 'category', label, resolved: true, description: `Category: ${label}` });
  }
  if (parsed.app !== null) {
    const app = resolveApp(parsed.app, apps);
    next = { ...next, app: app ?? parsed.app };
    operators.push(
      app
        ? { key: 'app', label: app, resolved: true, description: `App: ${app}` }
        : {
            key: 'app',
            label: parsed.app,
            resolved: false,
            description: `No app in the history matches "${parsed.app}"`,
          },
    );
  }
  if (parsed.kind !== null) {
    const label = kindLabel(parsed.kind);
    next = { ...next, kind: parsed.kind };
    operators.push({ key: 'kind', label, resolved: true, description: `Kind: ${label}` });
  }
  if (parsed.pinned) {
    next = { ...next, pinnedOnly: true };
    operators.push({
      key: 'pinned',
      label: 'Pinned',
      resolved: true,
      description: 'Pinned clips only',
    });
  }

  return { filters: next, operators };
}
