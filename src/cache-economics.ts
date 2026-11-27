import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { imageId, projectImages } from "./image-context.ts";

export type ImageProjection = ReturnType<typeof projectImages>;
type Identify = (image: ImageContent) => string | undefined;
export type CachePolicy = { cacheAware: boolean; cacheHorizonRequests: number; maxDeferredBase64Bytes: number };
export const defaultCachePolicy: CachePolicy = { cacheAware: true, cacheHorizonRequests: 4, maxDeferredBase64Bytes: 1024 * 1024 };

interface MessageFingerprint { key: string; tokens: number }
interface ProjectionSnapshot {
  raw: MessageFingerprint[];
  sent: MessageFingerprint[];
  omitted: Set<string>;
}
export interface WarmProjection extends ProjectionSnapshot {
  usage: Usage;
  at: number;
  cacheWriteSeen?: boolean;
  longCacheWriteSeen?: boolean;
}
export interface CacheDecision {
  reason: "economic" | "deferred" | "bandwidth limit" | "window pressure" | "pricing unavailable";
  savedTokensPerRequest: number;
  invalidatedRetainedTokens: number;
  horizonRequests: number;
  estimatedRewriteCost?: number;
  estimatedReadSavings?: number;
  breakEvenRequests?: number;
  deferredBase64Bytes: number;
}

function fingerprint(message: AgentMessage, identify: Identify): MessageFingerprint {
  // Retain only fingerprints and token estimates, never a second image transcript.
  const visible = message.role === "toolResult" ? { role: message.role, timestamp: message.timestamp, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, content: message.content } :
    message.role === "assistant" ? { role: message.role, timestamp: message.timestamp, model: message.model, content: message.content } : message;
  const key = createHash("sha256").update(JSON.stringify(visible, (_key, value) => {
    if (value && typeof value === "object" && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      return { type: "image", id: identify(value) ?? imageId(value) };
    }
    return value;
  })).digest("hex");
  return { key, tokens: estimateTokens(message) };
}

const blockKey = (i: number, j: number) => `${i}:${j}`;

export function snapshotProjection(raw: AgentMessage[], sent: AgentMessage[], identify: Identify, originals = raw.map(message => fingerprint(message, identify))): ProjectionSnapshot {
  const omitted = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const before = raw[i], after = sent[i];
    if ((before.role !== "user" && before.role !== "toolResult") || !Array.isArray(before.content) ||
        (after.role !== "user" && after.role !== "toolResult") || !Array.isArray(after.content)) continue;
    for (let j = 0; j < before.content.length; j++) {
      if (before.content[j].type === "image" && after.content[j]?.type === "text") omitted.add(blockKey(i, j));
    }
  }
  return { raw: originals, sent: sent.map((message, i) => message === raw[i] ? originals[i] : fingerprint(message, identify)), omitted };
}

function prefixLength(a: MessageFingerprint[], b: MessageFingerprint[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i].key === b[i].key) i++;
  return i;
}
const sumTokens = (messages: readonly MessageFingerprint[]) => messages.reduce((sum, message) => sum + message.tokens, 0);
const estimatedTokens = (messages: readonly AgentMessage[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);

function ratesFor(model: Pick<Model<string>, "cost">, inputTokens: number) {
  return (model.cost.tiers ?? []).filter(tier => inputTokens > tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? model.cost;
}

/** Compare extra cache reconstruction with future cached reads avoided, in catalog-price dollars. */
export function estimateCacheDecision(input: {
  savedTokensPerRequest: number; invalidatedRetainedTokens: number; horizonRequests: number; bytes: number;
  readRate: number; coldRate: number; maxDeferredBase64Bytes: number; windowPressure: boolean;
}): CacheDecision {
  const { savedTokensPerRequest, invalidatedRetainedTokens, horizonRequests } = input;
  const validRates = Number.isFinite(input.readRate) && input.readRate >= 0 && Number.isFinite(input.coldRate) && input.coldRate > 0;
  const rewrite = validRates ? invalidatedRetainedTokens * Math.max(0, input.coldRate - input.readRate) / 1e6 : undefined;
  const savingPerRequest = validRates ? savedTokensPerRequest * input.readRate / 1e6 : undefined;
  const savings = savingPerRequest === undefined ? undefined : savingPerRequest * horizonRequests;
  const payback = rewrite === 0 ? 0 : rewrite !== undefined && savingPerRequest && savingPerRequest > 0 ? rewrite / savingPerRequest : undefined;
  const reason = input.windowPressure ? "window pressure" : input.bytes >= input.maxDeferredBase64Bytes ? "bandwidth limit" :
    rewrite === undefined || savings === undefined ? "pricing unavailable" : savings >= rewrite ? "economic" : "deferred";
  return { reason, savedTokensPerRequest, invalidatedRetainedTokens, horizonRequests, estimatedRewriteCost: rewrite,
    estimatedReadSavings: savings, breakEvenRequests: payback, deferredBase64Bytes: reason === "deferred" ? input.bytes : 0 };
}

export function chooseProjection(raw: AgentMessage[], full: ImageProjection, identify: Identify, previous: WarmProjection | undefined,
  model: Pick<Model<string>, "cost" | "contextWindow">, policy: CachePolicy, windowPressure: boolean, now = Date.now()): { projection: ImageProjection; snapshot?: ProjectionSnapshot; decision?: CacheDecision } {
  if (!policy.cacheAware) return { projection: full };
  const hasImages = raw.some(message => (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) && message.content.some(block => block.type === "image"));
  if (!hasImages) return { projection: full };
  const candidate = snapshotProjection(raw, full.messages, identify);
  if (!full.omittedImages || !previous) return { projection: full, snapshot: candidate };
  // Five minutes bounds stale-cache assumptions; a reported hit is evidence, not a guarantee.
  if (now - previous.at > 5 * 60_000 || previous.usage.cacheRead <= 0) return { projection: full, snapshot: candidate };
  // The common steady state needs no second projection: all replacements were already deployed.
  if ([...candidate.omitted].every(key => {
    const i = Number(key.slice(0, key.indexOf(":")));
    return previous.omitted.has(key) && previous.raw[i]?.key === candidate.raw[i].key;
  })) return { projection: full, snapshot: candidate };
  // Preserve every previously deployed reference; defer only newly eligible historical blocks.
  const stable = projectImages(raw, () => true, identify, (i, j, active) => active ||
    (previous.raw[i]?.key === candidate.raw[i].key && previous.omitted.has(blockKey(i, j))));
  const bytes = full.omittedBase64Bytes - stable.omittedBase64Bytes;
  if (bytes <= 0) return { projection: full, snapshot: candidate };
  const retained = snapshotProjection(raw, stable.messages, identify, candidate.raw);
  const keepPrefix = prefixLength(previous.sent, retained.sent);
  const trimPrefix = prefixLength(previous.sent, candidate.sent);
  const previousInput = previous.usage.input + previous.usage.cacheRead + previous.usage.cacheWrite;
  if (!Number.isFinite(previousInput) || previousInput <= 0) return { projection: full, snapshot: candidate };
  const scale = previousInput / Math.max(1, sumTokens(previous.sent));
  const saved = Math.max(0, estimatedTokens(stable.messages) - estimatedTokens(full.messages));
  const removedFromPrefix = Math.max(0, sumTokens(retained.sent.slice(trimPrefix, keepPrefix)) - sumTokens(candidate.sent.slice(trimPrefix, keepPrefix)));
  const invalidated = Math.max(0, sumTokens(previous.sent.slice(trimPrefix, keepPrefix)) - removedFromPrefix);
  const rates = ratesFor(model, previousInput);
  const decision = estimateCacheDecision({ savedTokensPerRequest: Math.floor(saved * Math.min(1, scale)),
    invalidatedRetainedTokens: Math.ceil(invalidated * scale), horizonRequests: policy.cacheHorizonRequests, bytes,
    readRate: rates.cacheRead, coldRate: previous.longCacheWriteSeen ? Math.max(rates.input * 2, rates.cacheWrite) : previous.cacheWriteSeen || previous.usage.cacheWrite > 0 ? Math.max(rates.input, rates.cacheWrite) : rates.input,
    maxDeferredBase64Bytes: policy.maxDeferredBase64Bytes, windowPressure });
  return decision.reason === "deferred" ? { projection: stable, snapshot: retained, decision } : { projection: full, snapshot: candidate, decision };
}
