// Token Compression (TC) — entry point.
// Hybrid pipeline: Stage A (lossless) → Stage B (threshold check) → Stage C (history compaction).
//
// IMPORTANT: only mutates a deep-cloned body. Never touches `tool_result` content
// (that domain belongs to RTK in open-sse/rtk).

import {
  DEFAULT_TC_SETTINGS,
  MIN_TOTAL_CHARS_FOR_TC,
} from "./constants.js";
import { losslessNormalize } from "./lossless.js";
import {
  estimateBodyTokens,
  resolveThresholdTokens,
} from "./tokenEstimator.js";
import { compactOpenAIMessages, compactClaudeMessages } from "./history.js";
import { snapshotIntegrity, snapshotsCompatible } from "./safety.js";
import { formatTcLog } from "./log.js";

/**
 * Resolve effective TC settings by merging global + per-key override.
 * apiKeyMeta.tokenCompression keys override global tokenCompression keys
 * (only those explicitly set). If apiKeyMeta.tokenCompression.enabled === false,
 * TC is forced off regardless of global.
 */
export function resolveEffectiveTcSettings(globalTc, apiKeyOverride) {
  const base = { ...DEFAULT_TC_SETTINGS, ...(globalTc || {}) };
  base.summarizer = { ...DEFAULT_TC_SETTINGS.summarizer, ...((globalTc && globalTc.summarizer) || {}) };

  if (!apiKeyOverride || typeof apiKeyOverride !== "object") return base;

  const merged = { ...base };
  for (const k of Object.keys(apiKeyOverride)) {
    if (k === "summarizer" && apiKeyOverride.summarizer && typeof apiKeyOverride.summarizer === "object") {
      merged.summarizer = { ...base.summarizer, ...apiKeyOverride.summarizer };
      continue;
    }
    if (apiKeyOverride[k] !== undefined) merged[k] = apiKeyOverride[k];
  }
  return merged;
}

/**
 * Main entrypoint. Returns { body, stats } — stats is null if TC is disabled
 * or made no changes. The returned body is either the original (when nothing
 * changed) or a new object safe to forward downstream.
 *
 * @param {object} body
 * @param {object} options
 * @param {object} options.settings   merged effective TC settings
 * @param {string} [options.modelName]
 */
export function compressRequestBody(body, options = {}) {
  const settings = options.settings || DEFAULT_TC_SETTINGS;
  if (!settings.enabled) return { body, stats: null };
  if (!body || typeof body !== "object") return { body, stats: null };

  const startedAt = Date.now();
  const before = snapshotIntegrity(body);
  const tokensBeforeEst = estimateBodyTokens(body);

  // Quick bail-out for trivially small payloads
  const totalChars = approxTotalChars(body);
  if (totalChars < MIN_TOTAL_CHARS_FOR_TC) return { body, stats: null };

  const stages = [];
  let working = deepClone(body);

  // Stage A — lossless
  const aChanged = applyLosslessToBody(working, !!settings.protectCodeBlocks);
  if (aChanged) stages.push("A");

  // Stage B — threshold check
  const tokensAfterA = estimateBodyTokens(working);
  const threshold = resolveThresholdTokens(options.modelName || body.model, settings);

  // If still over threshold AND not lossless-only, run Stage C.
  let summarizerLabel = null;
  if (!settings.losslessOnly && tokensAfterA > threshold) {
    const cChanged = applyHistoryCompactionToBody(working, settings);
    if (cChanged) {
      stages.push("C");
      summarizerLabel = (settings.summarizer && settings.summarizer.mode) || "extractive";
    }
  }

  // Stage D — safety + regression guard
  const after = snapshotIntegrity(working);
  if (!snapshotsCompatible(before, after)) {
    return { body, stats: null }; // rollback silently
  }

  const tokensAfterEst = estimateBodyTokens(working);
  if (tokensAfterEst >= tokensBeforeEst) {
    return { body, stats: null }; // no benefit, rollback
  }

  if (stages.length === 0) return { body, stats: null };

  const stats = {
    tokensBeforeEst,
    tokensAfterEst,
    savedEst: tokensBeforeEst - tokensAfterEst,
    stages,
    summarizer: summarizerLabel,
    durationMs: Date.now() - startedAt,
    log: null,
  };
  stats.log = formatTcLog(stats);
  return { body: working, stats };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function deepClone(v) {
  // structuredClone is available in Node 17+ and modern browsers.
  // Falls back to JSON for environments where it's missing.
  try {
    if (typeof structuredClone === "function") return structuredClone(v);
  } catch { /* fallthrough */ }
  return JSON.parse(JSON.stringify(v));
}

function approxTotalChars(body) {
  let n = 0;
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === "string") { n += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (typeof v === "object") { for (const k of Object.keys(v)) visit(v[k]); return; }
  };
  visit(body.messages);
  visit(body.input);
  visit(body.system);
  visit(body.tools);
  visit(body.contents);
  return n;
}

/**
 * Apply lossless normalization to every text-bearing field.
 * Skips tool_result content (RTK domain).
 * @returns {boolean} true if any change was made
 */
function applyLosslessToBody(body, protectCodeBlocks) {
  let changed = false;
  const opts = { protectCodeBlocks };

  const normalizeStr = (s) => {
    if (typeof s !== "string") return s;
    const out = losslessNormalize(s, opts);
    if (out !== s) changed = true;
    return out;
  };

  // Top-level system (Claude/Anthropic)
  if (typeof body.system === "string") body.system = normalizeStr(body.system);
  else if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i++) {
      const b = body.system[i];
      if (b && typeof b === "object" && typeof b.text === "string") b.text = normalizeStr(b.text);
    }
  }

  // messages[] (OpenAI / Claude)
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) walkMessage(m, normalizeStr);
  }
  // input[] (OpenAI Responses)
  if (Array.isArray(body.input)) {
    for (const m of body.input) walkMessage(m, normalizeStr);
  }
  // contents[] (Gemini)
  if (Array.isArray(body.contents)) {
    for (const m of body.contents) walkGeminiMessage(m, normalizeStr);
  }

  return changed;
}

function walkMessage(m, normalizeStr) {
  if (!m) return;
  if (typeof m.content === "string") {
    // Skip tool messages — RTK handles them.
    if (m.role !== "tool") m.content = normalizeStr(m.content);
    return;
  }
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      // Skip tool_result entirely (RTK domain).
      if (b.type === "tool_result") continue;
      if (b.type === "text" && typeof b.text === "string") b.text = normalizeStr(b.text);
      if (b.type === "input_text" && typeof b.text === "string") b.text = normalizeStr(b.text);
    }
    return;
  }
  // OpenAI Responses output (function_call_output) is RTK domain — leave it.
}

function walkGeminiMessage(m, normalizeStr) {
  if (!m || !Array.isArray(m.parts)) return;
  for (const p of m.parts) {
    if (p && typeof p === "object" && typeof p.text === "string") p.text = normalizeStr(p.text);
  }
}

function applyHistoryCompactionToBody(body, settings) {
  let changed = false;

  // OpenAI / Claude messages array
  if (Array.isArray(body.messages)) {
    const looksClaude = !!body.system && (Array.isArray(body.system) || typeof body.system === "string");
    if (looksClaude) {
      const r = compactClaudeMessages(body.messages, { keepLastTurns: settings.keepLastTurns });
      if (r.changed) {
        body.messages = r.messages;
        changed = true;
      }
    } else {
      const r = compactOpenAIMessages(body.messages, { keepLastTurns: settings.keepLastTurns });
      if (r.changed) {
        body.messages = r.messages;
        changed = true;
      }
    }
  }

  // OpenAI Responses input[] — treat structurally like messages.
  if (Array.isArray(body.input)) {
    const r = compactOpenAIMessages(body.input, { keepLastTurns: settings.keepLastTurns });
    if (r.changed) {
      body.input = r.messages;
      changed = true;
    }
  }

  return changed;
}

export { formatTcLog };
