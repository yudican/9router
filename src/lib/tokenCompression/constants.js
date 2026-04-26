// Token Compression (TC) — constants & defaults

export const TC_SUMMARY_MARKER = "[TC-SUMMARY v1]";

// Approx token estimator: ~4 chars/token for latin, weighted higher for CJK.
// These are heuristics, not exact tokenizers.
export const APPROX_CHARS_PER_TOKEN = 4;
export const APPROX_CJK_CHARS_PER_TOKEN = 1.5;

// Skip TC entirely for messages smaller than this (no point compressing).
export const MIN_TOTAL_CHARS_FOR_TC = 2000;

// Per-text fields below this size are passed through Stage A but never Stage C.
export const MIN_TEXT_CHARS_FOR_LOSSLESS = 200;

// Hard caps to prevent pathological inputs from blocking the pipeline.
export const MAX_TEXT_CHARS_TO_PROCESS = 2_000_000;

// Default settings shape for tokenCompression (mirrors plan §6).
export const DEFAULT_TC_SETTINGS = {
  enabled: false,
  losslessOnly: false,
  threshold: 0.75,
  thresholdAbsolute: 8000,
  keepLastTurns: 6,
  summarizer: {
    mode: "extractive", // "extractive" | "llm" | "off"
    connectionId: null,
    model: null,
  },
  protectCodeBlocks: true,
  applyToResponseJson: false,
  observability: true,
};

// Known model context windows (very rough; used only for threshold ratio).
// Falls back to thresholdAbsolute when model is unknown.
export const MODEL_CONTEXT_WINDOWS = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4-turbo": 128_000,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4": 200_000,
  "gemini-1.5-pro": 1_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
};
