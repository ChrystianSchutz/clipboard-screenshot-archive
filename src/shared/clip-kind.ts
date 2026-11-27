import type { ClipKind } from './types';

const URL_PATTERN = /^https?:\/\/\S+$/i;

/** Lines that start with a keyword most languages share: code even when they read like words. */
const CODE_KEYWORD_LINE =
  /^\s*(?:import|export|const|let|var|function|class|def|return|if|for|while|public|private|#include|SELECT|INSERT|UPDATE)\b/;

/** Lines that end like code (`{`, `}`, `;`) or contain an arrow. */
const CODE_PUNCTUATION_LINE = /[{};]\s*$|=>/;

/** Bullet or numbered list markers: `- `, `* `, `+ `, `• `, `1. `, `2) `, `a. `, `b) `. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/;

/**
 * Natural-language text: letters, digits, spaces and sentence punctuation only. No `=`, `(`,
 * `{`, `_`, `"`, `/` or other operators, which nearly every code statement has.
 */
const PROSE_BODY = /^[\p{L}\p{M}\p{N}\s,.:;!?'’-]+$/u;

/** A prose line has at least this many words; short lines like `return a;` stay ambiguous. */
const PROSE_MIN_WORDS = 4;

/** Share of lines that must look like code before a multi-line clip is badged as code. */
const CODE_LINE_RATIO = 0.3;

/**
 * A sentence, optionally behind a list marker: `- Call the bank and ask about fees;`.
 * Such a line ends with `;` but is a to-do item, not a statement.
 */
function isProseLine(line: string): boolean {
  const body = line.replace(LIST_MARKER, '').trim();
  if (!PROSE_BODY.test(body)) return false;
  const words = body.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.length >= PROSE_MIN_WORDS;
}

function isCodeLine(line: string): boolean {
  if (CODE_KEYWORD_LINE.test(line)) return true;
  return CODE_PUNCTUATION_LINE.test(line) && !isProseLine(line);
}

/**
 * Classifies clipboard text once, at capture time, so the UI can badge and filter it cheaply.
 * Deliberately conservative: anything ambiguous is plain `text`.
 */
export function detectClipKind(content: string): ClipKind {
  const trimmed = content.trim();
  if (trimmed === '') return 'text';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === 'object' && value !== null) return 'json';
    } catch {
      // Not JSON: fall through to the other heuristics.
    }
  }

  if (URL_PATTERN.test(trimmed) && URL.canParse(trimmed)) return 'url';

  const lines = trimmed.split(/\r?\n/);
  if (lines.length >= 2) {
    const codeLines = lines.filter(isCodeLine).length;
    if (codeLines / lines.length >= CODE_LINE_RATIO) return 'code';
  }
  return 'text';
}
