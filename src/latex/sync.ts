// PDF → source at word level. SyncTeX only knows the line; this finds the clicked PDF word in the source near it.

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

/** Lowercase, without diacritics, ligatures expanded. */
export const fold = (s: string): string =>
  s.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const lastWord = (s: string): string => fold(/([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u.exec(s)?.[1] ?? "");
const firstWord = (s: string): string => fold(/^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(s)?.[1] ?? "");

/**
 * The offsets of `word` in `text` closest to the 1-based `line` (within three lines), preferring the occurrence whose
 * neighbouring words match the PDF context. Command names (`\section`) are not words. A fragment of at least four
 * letters matches the start of a source word (the PDF splits hyphenated words).
 */
export function findSourceWord(
  text: string,
  line: number,
  word: string | null,
  before = "",
  after = "",
  column?: number,
): { from: number; to: number } | null {
  if (!word) return null;
  const wanted = fold(word);
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const previous = lastWord(before);
  const next = firstWord(after);
  let best: { from: number; to: number; score: number } | null = null;
  for (let n = Math.max(1, line - 3); n <= Math.min(lines.length, line + 3); n++) {
    const source = lines[n - 1]!;
    const words = [...source.matchAll(/\\?[\p{L}\p{N}@]+/gu)].filter((m) => !m[0].startsWith("\\"));
    for (const [i, m] of words.entries()) {
      const candidate = fold(m[0]);
      const exact = candidate === wanted;
      if (!exact && !(wanted.length >= 4 && candidate.startsWith(wanted))) continue;
      let score = Math.abs(n - line) * 10 + (exact ? 0 : 5);
      if (previous && fold(words[i - 1]?.[0] ?? "") === previous) score -= 6;
      if (next && fold(words[i + 1]?.[0] ?? "") === next) score -= 6;
      if (column && n === line) score += Math.min(5, Math.abs(m.index + 1 - column) / 20);
      const from = starts[n - 1]! + m.index;
      if (!best || score < best.score) best = { from, to: from + m[0].length, score };
    }
  }
  return best ? { from: best.from, to: best.to } : null;
}
