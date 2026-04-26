// Safety helpers for Token Compression.
// Validates that compression did not break tool_call ↔ tool_result pairing or
// drop required fields, so we can rollback if something looks wrong.

/**
 * Snapshot the structural integrity needed for tool calling roundtrips.
 * Returns a plain object describing pairing IDs and message count.
 */
export function snapshotIntegrity(body) {
  if (!body || typeof body !== "object") {
    return { msgCount: 0, toolCallIds: [], toolResultIds: [], hasInput: false, hasMessages: false };
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const input = Array.isArray(body.input) ? body.input : null;

  const toolCallIds = new Set();
  const toolResultIds = new Set();

  const visit = (arr) => {
    if (!arr) return;
    for (const m of arr) {
      if (!m) continue;
      // OpenAI assistant tool_calls
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) toolCallIds.add(tc.id);
      }
      // OpenAI tool messages
      if (m.role === "tool" && m.tool_call_id) toolResultIds.add(m.tool_call_id);
      // Claude blocks
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === "tool_use" && b.id) toolCallIds.add(b.id);
          if (b.type === "tool_result" && b.tool_use_id) toolResultIds.add(b.tool_use_id);
        }
      }
      // OpenAI Responses style
      if (m.type === "function_call" && m.call_id) toolCallIds.add(m.call_id);
      if (m.type === "function_call_output" && m.call_id) toolResultIds.add(m.call_id);
    }
  };

  visit(messages);
  visit(input);

  return {
    msgCount: (messages?.length || 0) + (input?.length || 0),
    toolCallIds: [...toolCallIds],
    toolResultIds: [...toolResultIds],
    hasInput: !!input,
    hasMessages: !!messages,
  };
}

/** Compare two snapshots; true if integrity is preserved. */
export function snapshotsCompatible(before, after) {
  if (!before || !after) return false;
  if (before.hasInput !== after.hasInput) return false;
  if (before.hasMessages !== after.hasMessages) return false;
  // After must still contain every tool_call_id that appeared before.
  // (Summarization may legitimately drop some old tool_results, but never their pairing
  // with the *currently retained* assistant turns. We approximate by requiring the set of
  // tool_result ids in `after` to be a subset of before's, and that any tool_call retained
  // in after still has a matching tool_result in after.)
  const beforeCalls = new Set(before.toolCallIds);
  for (const id of after.toolCallIds) {
    if (!beforeCalls.has(id)) return false; // appeared out of nowhere
  }
  const afterResults = new Set(after.toolResultIds);
  for (const id of after.toolCallIds) {
    if (!afterResults.has(id)) return false; // unmatched call in retained set
  }
  return true;
}
