/** Inline 16px stroke icons: no icon font, no network, CSP-friendly. */
const PATHS = {
  search: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM14.5 14.5l-3.6-3.6',
  pin: 'M9.5 1.5l5 5-2 .5-3 3 .5 3.5-1.5 1.5-3-3-3.5 3.5M5.5 9.5l-3-3L4 5l3.5.5 3-3 .5-2',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  compare: 'M2 5h9.5M9 2.5 11.5 5 9 7.5M14 11H4.5M7 8.5 4.5 11 7 13.5',
  clock: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.5 1.5',
  chart: 'M2 14h12M4 11.5V8M7 11.5V4.5M10 11.5V6.5M13 11.5V2.5',
  settings:
    'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM13 8l1.3-1-1.2-2.1-1.6.4-1-.6L10 3H7.6l-.5 1.7-1 .6-1.6-.4L3.3 7 4.6 8l-1.3 1 1.2 2.1 1.6-.4 1 .6.5 1.7H10l.5-1.7 1-.6 1.6.4L14.3 9 13 8Z',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  app: 'M2 3.5h12v9H2zM2 6h12',
  check: 'M3 8.5l3 3 7-7',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3.2l2 1.3',
  swap: 'M4.5 2v12M2 4.5 4.5 2 7 4.5M11.5 14V2M9 11.5l2.5 2.5 2.5-2.5',
  regex: 'M11.5 2v6M9 3.5l5 3M9 6.5l5-3M3.5 13.5a1.5 1.5 0 1 0 0-.01',
  sort: 'M3 4h10M3 8h7M3 12h4',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12M10.5 6.5a1 1 0 1 0 0-.01',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly label?: string;
}

export function Icon({ name, size = 16, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
