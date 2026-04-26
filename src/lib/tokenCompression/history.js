// Stage C — history compression.
// Strategy: keep last N "turns" verbatim, compact older turns into a single
// extractive summary system message marked with TC_SUMMARY_MARKER.

import { TC_SUMMARY_MARKER } from "./constants.js";

/**
 * Compact the older portion of an OpenAI-style messages array.
 * Returns a new array; never mutates the input.
 *
 * Rules:
 * - Always preserve the first system message(s) (if at the front).
 * - Always preserve the last `keepLastTurns` non-system messages.
 * - Always preserve any assistant message with tool_calls AND its matching
 *   tool messages, if either is in the keep window.
 * - Older messages are replaced by a single system message containing an
 *   extractive summary.
 */
export function compactOpenAIMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, changed: false };
  const keepLastTurns = Math.max(1, Number(opts.keepLastTurns) || 6);

  // 1. Pull leading system messages
  const systems = [];
  let i = 0;
  while (i < messages.length && messages[i]?.role === "system") {
    systems.push(messages[i]);
    i++;
  }
  const rest = messages.slice(i);
  if (rest.length <= keepLastTurns) return { messages, changed: false };

  // 2. Determine cut point. Walk backward to keep last N non-system messages.
  let keepFrom = rest.length - keepLastTurns;

  // 3. Adjust to preserve assistant.tool_calls ↔ tool pairings spanning the cut.
  // If the keep window starts in the middle of a tool exchange, expand it backward.
  while (keepFrom > 0) {
    const head = rest[keepFrom];
    // If we're starting on a "tool" message, we need its assistant tool_calls before it.
    if (head?.role === "tool" || (Array.isArray(head?.content) && head.content.some((b) => b?.type === "tool_result"))) {
      keepFrom--;
      continue;
    }
    break;
  }

  const older = rest.slice(0, keepFrom);
  const recent = rest.slice(keepFrom);

  if (older.length === 0) return { messages, changed: false };

  // 4. Build extractive summary
  const summaryText = buildExtractiveSummary(older);
  const summaryMessage = {
    role: "system",
    content: `${TC_SUMMARY_MARKER} compacted ${older.length} older messages\n${summaryText}`,
  };

  return {
    messages: [...systems, summaryMessage, ...recent],
    changed: true,
    droppedCount: older.length,
  };
}

/**
 * Compact Claude-style messages array (role+content blocks).
 * Same rules; summary is injected as a leading user message tagged with marker
 * because Claude doesn't support a separate `system` role in messages array
 * (system is a top-level field).
 */
export function compactClaudeMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, changed: false };
  const keepLastTurns = Math.max(1, Number(opts.keepLastTurns) || 6);
  if (messages.length <= keepLastTurns) return { messages, changed: false };

  let keepFrom = messages.length - keepLastTurns;

  while (keepFrom > 0) {
    const head = messages[keepFrom];
    if (Array.isArray(head?.content) && head.content.some((b) => b?.type === "tool_result")) {
      keepFrom--;
      continue;
    }
    break;
  }

  const older = messages.slice(0, keepFrom);
  const recent = messages.slice(keepFrom);
  if (older.length === 0) return { messages, changed: false };

  const summaryText = buildExtractiveSummary(older);
  const summaryMessage = {
    role: "user",
    content: [{ type: "text", text: `${TC_SUMMARY_MARKER} compacted ${older.length} older messages\n${summaryText}` }],
  };

  return {
    messages: [summaryMessage, ...recent],
    changed: true,
    droppedCount: older.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Extractive summary helpers
// ──────────────────────────────────────────────────────────────────────────

const ANCHOR_PATTERNS = [
  /\b(error|exception|failed|timeout|denied|unauthorized)\b/i,
  /\b(file|path|module|class|function|method)\b/i,
  /\b(todo|fixme|note|warning|caution)\b/i,
  /\b\d+\b/, // any number is often anchor (line numbers, sizes, dates)
  /[\/\\][\w\-.]+/, // path-like
  /`[^`]+`/, // inline code
  /[A-Z][a-zA-Z]+\.[a-zA-Z]+/, // identifier.like
];

function buildExtractiveSummary(messages) {
  const bullets = [];
  for (const m of messages) {
    if (!m) continue;
    const role = m.role || (m.type === "function_call_output" ? "tool" : m.type) || "?";
    const text = collectMessageText(m);
    if (!text) continue;
    const condensed = condense(text, role);
    if (condensed) bullets.push(`- [${role}] ${condensed}`);
  }
  return bullets.join("\n");
}

function collectMessageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts = [];
    for (const b of m.content) {
      if (!b) continue;
      if (typeof b === "string") parts.push(b);
      else if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "tool_use") parts.push(`<tool_use:${b.name || ""}>`);
      else if (b.type === "tool_result") parts.push(`<tool_result>`);
      else if (b.type === "input_text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n");
  }
  if (typeof m.output === "string") return m.output;
  if (Array.isArray(m.tool_calls)) {
    return m.tool_calls
      .map((tc) => `<tool_call:${tc?.function?.name || tc?.name || ""}>`)
      .join(" ");
  }
  return "";
}

function condense(text, role) {
  if (!text) return "";
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  // Keep anchor lines and the first/last line
  const keep = new Set();
  keep.add(0);
  keep.add(lines.length - 1);
  for (let i = 0; i < lines.length; i++) {
    if (ANCHOR_PATTERNS.some((re) => re.test(lines[i]))) keep.add(i);
  }
  // Cap kept lines for a turn to avoid runaway summaries
  const MAX_KEEP = role === "assistant" ? 6 : 4;
  const kept = [...keep].sort((a, b) => a - b).slice(0, MAX_KEEP);

  const condensedLines = kept.map((idx) => truncateLine(lines[idx], 240));
  let out = condensedLines.join(" / ");
  // Final hard cap on the per-message bullet
  if (out.length > 600) out = out.slice(0, 597) + "...";
  return out;
}

function truncateLine(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
