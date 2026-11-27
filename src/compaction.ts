import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Avoid subtracting historical image estimates from usage that may already include a trim. */
export function thresholdDeferral(raw: AgentMessage[], trimmed: AgentMessage[], tokensBefore: number, contextWindow: number, reserveTokens: number) {
  const threshold = contextWindow - reserveTokens;
  const lastUsage = raw.findLastIndex(message => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && calculateContextTokens(message.usage) > 0);
  // Pi's usage-backed estimate only adds estimates for messages after the last valid usage.
  // Crediting older images again could double-count a reduction already reported by the provider.
  const rawTrailing = estimateMessageTokens(raw.slice(lastUsage + 1));
  const trimmedTrailing = estimateMessageTokens(trimmed.slice(lastUsage + 1));
  const savings = Math.max(0, rawTrailing - trimmedTrailing);
  const projectedTokens = Math.max(estimateMessageTokens(trimmed), tokensBefore - savings);
  const last = raw[lastUsage];
  const measuredBound = last?.role === "assistant" ? calculateContextTokens(last.usage) + trimmedTrailing : 0;
  const safeTokens = Math.max(projectedTokens, measuredBound);
  const margin = Math.max(1, Math.ceil(reserveTokens / 10));
  return { defer: savings > 0 && threshold > 0 && safeTokens <= threshold - margin, safeTokens, savings, threshold };
}
