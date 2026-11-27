import type { ClipKind } from './types';

/**
 * Automatic categories: tags attached to a clip at capture time from cheap, local rules.
 *
 * A kind says what *shape* the text has (JSON, URL, code, text), and every clip has exactly one.
 * Categories say what the text *is*, and a clip can have several: a SQL query pasted from an
 * error log is both `sql` and `error`. Rules are intentionally strict, since a wrong tag is worse
 * than none.
 */
export const CATEGORIES = [
  'secret',
  'error',
  'sql',
  'command',
  'email',
  'path',
  'uuid',
  'ip',
  'color',
  'number',
  'markdown',
  'html',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  secret: 'Secret',
  error: 'Error',
  sql: 'SQL',
  command: 'Command',
  email: 'Email',
  path: 'File path',
  uuid: 'UUID',
  ip: 'IP address',
  color: 'Color',
  number: 'Number',
  markdown: 'Markdown',
  html: 'HTML',
};

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Rules only look at the start of huge clips: classification must never stall capture. */
const SCAN_LIMIT = 20_000;

interface Sample {
  /** Trimmed text, capped at SCAN_LIMIT. */
  readonly text: string;
  readonly lines: readonly string[];
  readonly singleLine: boolean;
  readonly kind: ClipKind;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/, // JWT
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
];

const ERROR_PATTERNS: readonly RegExp[] = [
  /^Traceback \(most recent call last\):/m, // Python
  /^\s+at [\w$.<>[\]]+ ?\(.*:\d+(?::\d+)?\)$/m, // JS / Java / C# stack frame
  /^\s+at .+:\d+:\d+$/m,
  /^(?:Uncaught )?(?:[A-Z]\w*)?(?:Error|Exception)(?:: |\s*$)/m,
  /^panic: /m, // Go
  /^error(?:\[E\d+\])?: /m, // Rust / compilers
  /^Fatal error: /m, // PHP
];

const SQL_PATTERN =
  /^(?:WITH\b[\s\S]+\bAS\s*\(|SELECT\b[\s\S]+\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]+\bSET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|VIEW|UNIQUE)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX|VIEW)\b)/i;

const COMMAND_PATTERN =
  /^(?:\$ |> |PS [A-Z]:\\[^>]*> )?(?:sudo |npx |pnpm |yarn |npm |git |docker |podman |kubectl |helm |terraform |aws |az |gcloud |curl |wget |ssh |scp |cd |ls |mkdir |rm |cp |mv |cat |grep |find |chmod |python3? |pip3? |node |deno |bun |cargo |go |dotnet |brew |apt(?:-get)? |winget |choco |code |make |gh )\S/;

const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\[\w.-]+\\)[^<>:"|?*\r\n]*$/;
const UNIX_PATH = /^(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+\/?$/;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?:\/\d{1,2})?$/;
const COLOR_PATTERN =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|oklch|oklab)\([\d\s.,%/+-]+\))$/i;
const NUMBER_PATTERN = /^[-+]?(?:\d{1,3}(?:[ ,_]\d{3})+|\d+)(?:[.,]\d+)?(?:e[-+]?\d+)?%?$/i;
const MARKDOWN_LINE = /^(?:#{1,6} \S|[-*] \[[ x]\] |```|> \S|\|.+\|\s*$)|\[[^\]]+\]\([^)]+\)/;
const HTML_PATTERN =
  /^<(?:!doctype html|html|div|span|p|a|ul|ol|li|table|section|svg|button|img|head|body)\b[\s\S]*>$/i;

const RULES: readonly (readonly [Category, (sample: Sample) => boolean])[] = [
  ['secret', ({ text }) => SECRET_PATTERNS.some((pattern) => pattern.test(text))],
  ['error', ({ text }) => ERROR_PATTERNS.some((pattern) => pattern.test(text))],
  ['sql', ({ text }) => SQL_PATTERN.test(text)],
  ['command', ({ text, lines }) => lines.length <= 3 && COMMAND_PATTERN.test(text)],
  ['email', ({ text, singleLine }) => singleLine && EMAIL_PATTERN.test(text)],
  [
    'path',
    ({ text, singleLine }) => singleLine && (WINDOWS_PATH.test(text) || UNIX_PATH.test(text)),
  ],
  ['uuid', ({ text, kind }) => kind !== 'url' && UUID_PATTERN.test(text)],
  ['ip', ({ text, singleLine }) => singleLine && IPV4_PATTERN.test(text)],
  ['color', ({ text, singleLine }) => singleLine && COLOR_PATTERN.test(text)],
  ['number', ({ text, singleLine }) => singleLine && NUMBER_PATTERN.test(text)],
  [
    'markdown',
    ({ lines, kind }) =>
      kind === 'text' &&
      lines.length >= 2 &&
      lines.filter((line) => MARKDOWN_LINE.test(line)).length >= 2,
  ],
  ['html', ({ text, kind }) => kind !== 'json' && HTML_PATTERN.test(text)],
];

/** Every category that applies to `content`, in the fixed `CATEGORIES` order. */
export function detectCategories(content: string, kind: ClipKind): Category[] {
  const text = content.slice(0, SCAN_LIMIT).trim();
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  const sample: Sample = { text, lines, singleLine: lines.length === 1, kind };
  return RULES.filter(([, matches]) => matches(sample)).map(([category]) => category);
}
