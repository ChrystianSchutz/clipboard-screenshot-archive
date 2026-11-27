import { useCallback, useEffect, useRef, useState } from 'react';

export interface Toast {
  readonly id: number;
  readonly message: string;
}

/** A single transient message: a new one replaces the old one instead of stacking. */
export function useToast(durationMs = 1800): {
  toast: Toast | null;
  notify: (message: string) => void;
} {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback(
    (message: string) => {
      clearTimeout(timer.current);
      setToast((current) => ({ id: (current?.id ?? 0) + 1, message }));
      timer.current = setTimeout(() => setToast(null), durationMs);
    },
    [durationMs],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { toast, notify };
}
