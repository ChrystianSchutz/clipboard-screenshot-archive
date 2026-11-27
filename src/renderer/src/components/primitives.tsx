import type { ReactNode } from 'react';
import type { ClipKind } from '@shared/types';

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

const KIND_LABELS: Record<ClipKind, string> = {
  json: 'JSON',
  url: 'URL',
  code: 'Code',
  text: 'Text',
  image: 'Image',
};

export function kindLabel(kind: ClipKind): string {
  return KIND_LABELS[kind];
}

export function KindBadge({ kind }: { readonly kind: ClipKind }) {
  return <span className={`badge badge--${kind}`}>{KIND_LABELS[kind]}</span>;
}

interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

interface SegmentedProps<T extends string> {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly label: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
