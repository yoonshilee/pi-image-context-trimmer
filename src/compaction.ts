import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens, type SessionEntry, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function estimateProjectedTokens(messages: readonly AgentMessage[]): number {
  const system = getCurrentSystemMessage(messages);
  return (system ? estimateTokens(system) : 0) + messages.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}

/** Avoid subtracting historical image estimates from usage that may already include a trim. */
export function thresholdDeferral(raw: AgentMessage[], trimmed: AgentMessage[], tokensBefore: number, contextWindow: number, reserveTokens: number,
  session?: { projection: Pick<SessionProjection, "entries">; branchEntries: readonly SessionEntry[] }) {
  const threshold = contextWindow - reserveTokens;
  let lastUsage = raw.findLastIndex(message => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage && calculateContextTokens(message.usage) > 0);
  if (session && lastUsage >= 0) {
    let remaining = lastUsage;
    let usageEntryIndex = -1;
    for (const entry of session.projection.entries) {
      if (remaining < entry.messages.length) {
        usageEntryIndex = session.branchEntries.findIndex(source => source.id === entry.sourceEntry.id);
        break;
      }
      remaining -= entry.messages.length;
    }
    // Like Pi's projected estimator, discard usage captured before a context edit or compaction.
    const invalidatingEntryIndex = session.branchEntries.findLastIndex(entry => entry.type === "context_edit" || entry.type === "compaction");
    if (usageEntryIndex <= invalidatingEntryIndex) lastUsage = -1;
  }
  // Pi's usage-backed estimate only adds estimates for messages after the last valid usage.
  // Crediting older images again could double-count a reduction already reported by the provider.
  const estimator = session && lastUsage === -1 ? estimateProjectedTokens : estimateMessageTokens;
  const rawTrailing = estimator(raw.slice(lastUsage + 1));
  const trimmedTrailing = estimator(trimmed.slice(lastUsage + 1));
  const savings = Math.max(0, rawTrailing - trimmedTrailing);
  const projectedTokens = Math.max(session ? estimateProjectedTokens(trimmed) : estimateMessageTokens(trimmed), tokensBefore - savings);
  const last = raw[lastUsage];
  const measuredBound = last?.role === "assistant" ? calculateContextTokens(last.usage) + trimmedTrailing : 0;
  const safeTokens = Math.max(projectedTokens, measuredBound);
  const margin = Math.max(1, Math.ceil(reserveTokens / 10));
  return { defer: savings > 0 && threshold > 0 && safeTokens <= threshold - margin, safeTokens, savings, threshold };
}
