// Approximate token estimator. Tokenizer-agnostic; never claims to be exact.
// Strategy: count CJK chars as ~1.5 chars/token (denser tokens), else 4 chars/token.

import {
  APPROX_CHARS_PER_TOKEN,
  APPROX_CJK_CHARS_PER_TOKEN,
  MODEL_CONTEXT_WINDOWS,
} from "./constants.js";

const CJK_REGEX = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

/** Estimate tokens for a string. */
export function estimateTokensForString(str) {
  if (!str) return 0;
  if (typeof str !== "string") return 0;
  const cjkMatches = str.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = str.length - cjkCount;
  const cjkTokens = cjkCount / APPROX_CJK_CHARS_PER_TOKEN;
  const otherTokens = otherCount / APPROX_CHARS_PER_TOKEN;
  return Math.ceil(cjkTokens + otherTokens);
}

/** Recursively walk an object/array and sum string tokens. */
export function estimateTokensForValue(value) {
  if (value == null) return 0;
  if (typeof value === "string") return estimateTokensForString(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) {
    let total = 0;
    for (const v of value) total += estimateTokensForValue(v);
    return total;
  }
  if (typeof value === "object") {
    let total = 0;
    for (const k of Object.keys(value)) total += estimateTokensForValue(value[k]);
    return total;
  }
  return 0;
}

/** Estimate total tokens of a chat-completions / Claude / Responses body. */
export function estimateBodyTokens(body) {
  if (!body) return 0;
  let total = 0;
  if (Array.isArray(body.messages)) total += estimateTokensForValue(body.messages);
  if (Array.isArray(body.input)) total += estimateTokensForValue(body.input);
  if (typeof body.system === "string") total += estimateTokensForString(body.system);
  if (Array.isArray(body.system)) total += estimateTokensForValue(body.system);
  if (Array.isArray(body.tools)) total += estimateTokensForValue(body.tools);
  if (Array.isArray(body.contents)) total += estimateTokensForValue(body.contents);
  return total;
}

/** Resolve effective threshold token count for a model. */
export function resolveThresholdTokens(modelName, tcSettings) {
  const ratio = clamp(Number(tcSettings.threshold) || 0.75, 0.1, 0.99);
  const absolute = Math.max(1024, Number(tcSettings.thresholdAbsolute) || 8000);
  if (!modelName) return absolute;
  // Try exact, then prefix match.
  const exact = MODEL_CONTEXT_WINDOWS[modelName];
  if (exact) return Math.floor(exact * ratio);
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (modelName.startsWith(key)) return Math.floor(MODEL_CONTEXT_WINDOWS[key] * ratio);
  }
  return absolute;
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
