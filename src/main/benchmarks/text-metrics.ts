/** Accuracy metrics for the OCR benchmark (pure, so they are tested like any other code). */

/** Edit distance between two strings, by code point (so "ż" counts as one character). */
export function levenshtein(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** Code points, not grapheme clusters: OCR output is compared letter by letter, and the fixtures hold no emoji. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Collapses runs of whitespace (indentation, line breaks) so layout differences do not count as errors. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Character error rate: edits needed to turn the recognised text into the expected text, divided
 * by the expected length. 0 is perfect; 0.02 means 2 wrong characters in 100.
 */
export function characterErrorRate(expected: string, actual: string): number {
  const reference = normalizeWhitespace(expected);
  if (reference.length === 0) return actual.trim().length === 0 ? 0 : 1;
  return levenshtein(reference, normalizeWhitespace(actual)) / codePoints(reference).length;
}
