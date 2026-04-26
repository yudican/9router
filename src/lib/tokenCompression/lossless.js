// Stage A — lossless text normalization.
// Goal: shrink text without changing semantics. Code blocks are preserved verbatim.

import { MAX_TEXT_CHARS_TO_PROCESS, MIN_TEXT_CHARS_FOR_LOSSLESS } from "./constants.js";

const FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

/**
 * Apply lossless normalization to a single string.
 * - Splits on fenced code blocks; only normalizes outside fences.
 * - Normalizes line endings, collapses 3+ blank lines, strips trailing spaces,
 *   collapses runs of 2+ identical adjacent lines.
 * @param {string} text
 * @param {{ protectCodeBlocks?: boolean }} opts
 */
export function losslessNormalize(text, opts = {}) {
  if (typeof text !== "string") return text;
  if (text.length < MIN_TEXT_CHARS_FOR_LOSSLESS) return text;
  if (text.length > MAX_TEXT_CHARS_TO_PROCESS) return text;

  const protectCode = opts.protectCodeBlocks !== false;

  if (!protectCode) return normalizePlain(text);

  // Split into segments alternating non-fence / fence
  const parts = [];
  let lastIndex = 0;
  let m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push({ kind: "text", value: text.slice(lastIndex, m.index) });
    parts.push({ kind: "fence", value: m[0] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push({ kind: "text", value: text.slice(lastIndex) });

  let out = "";
  for (const p of parts) {
    if (p.kind === "fence") out += p.value;
    else out += normalizePlain(p.value);
  }

  // Safety: never grow the input.
  if (out.length >= text.length) return text;
  return out;
}

function normalizePlain(s) {
  if (!s) return s;
  // Normalize line endings
  let t = s.replace(/\r\n?/g, "\n");
  // Strip trailing spaces per line
  t = t.replace(/[ \t]+\n/g, "\n");
  // NFC unicode normalization (cheap; preserves semantics)
  try { t = t.normalize("NFC"); } catch { /* ignore */ }
  // Collapse 3+ blank lines into 2
  t = t.replace(/\n{3,}/g, "\n\n");
  // Collapse runs of identical adjacent lines (>=3 same in a row → keep one + "(repeated Nx)")
  t = collapseIdenticalLines(t);
  return t;
}

function collapseIdenticalLines(s) {
  const lines = s.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= 3 && lines[i].trim().length > 0) {
      out.push(lines[i]);
      out.push(`… (line repeated ${run}x)`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join("\n");
}
