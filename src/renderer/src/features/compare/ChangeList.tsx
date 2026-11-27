import { formatPath, previewValue, type JsonChange } from '@shared/json-diff';

const SYMBOL: Record<JsonChange['type'], string> = { added: '+', removed: '−', changed: '~' };
const LABEL: Record<JsonChange['type'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

/** Every structural difference as one row: path, then old → new value. */
export function ChangeList({ changes }: { readonly changes: readonly JsonChange[] }) {
  return (
    <ol className="changes" aria-label="Differences">
      {changes.map((change) => {
        const path = formatPath(change.path);
        return (
          <li key={`${change.type}:${path}`} className={`change change--${change.type}`}>
            <span
              className="change__symbol"
              aria-label={LABEL[change.type]}
              title={LABEL[change.type]}
            >
              {SYMBOL[change.type]}
            </span>
            <code className="change__path">{path}</code>
            <span className="change__values mono">
              {change.type === 'changed' ? (
                <>
                  <span className="value value--before">{previewValue(change.before)}</span>
                  <span className="change__arrow" aria-label="becomes">
                    →
                  </span>
                  <span className="value value--after">{previewValue(change.after)}</span>
                </>
              ) : (
                <span className={`value value--${change.type === 'added' ? 'after' : 'before'}`}>
                  {previewValue(change.value)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
