import { describe, expect, it } from 'vitest';
import { applySearchOperators } from './search-operators';
import { DEFAULT_FILTERS, toQuery, type HistoryFilters } from './useHistory';

const APPS = ['Google Chrome', 'VS Code', 'Slack'];
const withText = (text: string, extra: Partial<HistoryFilters> = {}): HistoryFilters => ({
  ...DEFAULT_FILTERS,
  ...extra,
  text,
});

describe('applySearchOperators', () => {
  it('leaves plain text alone and reports no operators', () => {
    const result = applySearchOperators(withText('connection timeout'), APPS);

    expect(result.operators).toEqual([]);
    expect(result.filters).toEqual(withText('connection timeout'));
  });

  it('turns #sql, app:chrome and is:pinned into filters and strips them from the text', () => {
    const { filters, operators } = applySearchOperators(
      withText('users #sql app:chrome is:pinned'),
      APPS,
    );

    expect(filters).toMatchObject({
      text: 'users',
      category: 'sql',
      app: 'Google Chrome',
      pinnedOnly: true,
    });
    expect(operators.map((op) => [op.key, op.label, op.resolved])).toEqual([
      ['category', 'SQL', true],
      ['app', 'Google Chrome', true],
      ['pinned', 'Pinned', true],
    ]);
  });

  it('resolves a quoted app name', () => {
    expect(applySearchOperators(withText('app:"vs code"'), APPS).filters.app).toBe('VS Code');
  });

  it('applies an unknown app as typed, so nothing matches, and flags it as unresolved', () => {
    const { filters, operators } = applySearchOperators(withText('app:photoshop'), APPS);

    expect(filters.app).toBe('photoshop');
    expect(operators).toEqual([
      expect.objectContaining({ key: 'app', label: 'photoshop', resolved: false }),
    ]);
  });

  it('lets an operator override the matching control', () => {
    const controls = withText('kind:json #error', { kind: 'text', category: 'sql', app: 'Slack' });

    const { filters } = applySearchOperators(controls, APPS);

    expect(filters).toMatchObject({ kind: 'json', category: 'error', app: 'Slack' });
  });

  it('keeps control values that no operator touches', () => {
    const controls = withText('#sql', { range: '7d', pinnedOnly: true });

    expect(applySearchOperators(controls, APPS).filters).toMatchObject({
      range: '7d',
      pinnedOnly: true,
    });
  });

  it('does not parse operators in regex mode: the whole text is the pattern', () => {
    const controls = withText('^#sql app:x$', { regex: true });

    const result = applySearchOperators(controls, APPS);

    expect(result).toEqual({ filters: controls, operators: [] });
  });

  it('feeds the IPC query end to end: text, category, app and pinned', () => {
    const { filters } = applySearchOperators(withText('timeout #error app:slack is:pinned'), APPS);

    expect(toQuery(filters, 60)).toEqual({
      limit: 60,
      text: 'timeout',
      regex: false,
      app: 'Slack',
      category: 'error',
      pinnedOnly: true,
    });
  });

  it('sends no text when only operators were typed', () => {
    const { filters } = applySearchOperators(withText('#sql'), APPS);

    expect(toQuery(filters, 60)).toEqual({ limit: 60, category: 'sql' });
  });
});
