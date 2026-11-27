import { useState, type KeyboardEvent } from 'react';
import { chordToAccelerator, displayAccelerator } from '@shared/accelerator';

interface ShortcutRecorderProps {
  readonly label: string;
  readonly value: string;
  readonly platform: string;
  /** Resolves with an error message when the shortcut could not be registered. */
  readonly onChange: (accelerator: string) => Promise<string | null>;
}

/** Click, press the new key combination, done. Esc cancels. */
export function ShortcutRecorder({ label, value, platform, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = (): void => {
    setRecording(false);
    setHint(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      stop();
      return;
    }

    const result = chordToAccelerator(event, platform);
    if (result.status !== 'complete') {
      setHint(result.status === 'pending' ? 'Now press a key…' : result.reason);
      return;
    }

    stop();
    if (result.accelerator === value) return;
    void onChange(result.accelerator).then(setError);
  };

  return (
    <div className="shortcut">
      <button
        type="button"
        className={`shortcut__field ${recording ? 'shortcut__field--recording' : ''}`}
        aria-label={`${label}: ${displayAccelerator(value, platform)}. Click to change.`}
        onClick={() => {
          setError(null);
          setRecording(true);
        }}
        onBlur={stop}
        onKeyDown={onKeyDown}
      >
        {recording ? (hint ?? 'Press a shortcut…') : displayAccelerator(value, platform)}
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
