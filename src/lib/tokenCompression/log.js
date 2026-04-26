// Console log formatting for Token Compression stats.

/**
 * @param {object} stats
 * @param {number} stats.tokensBeforeEst
 * @param {number} stats.tokensAfterEst
 * @param {string[]} stats.stages
 * @param {string|null} stats.summarizer
 * @param {number} stats.durationMs
 */
export function formatTcLog(stats) {
  if (!stats) return null;
  const saved = Math.max(0, stats.tokensBeforeEst - stats.tokensAfterEst);
  if (saved === 0 && (!stats.stages || stats.stages.length === 0)) return null;
  const pct = stats.tokensBeforeEst > 0
    ? ((saved / stats.tokensBeforeEst) * 100).toFixed(1)
    : "0";
  const stages = (stats.stages || []).join(",") || "-";
  const sum = stats.summarizer ? `,sum:${stats.summarizer}` : "";
  return `[TC] saved ~${formatTokens(saved)} tok / ${formatTokens(stats.tokensBeforeEst)} (${pct}%) via [${stages}${sum}] in ${stats.durationMs}ms`;
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}
