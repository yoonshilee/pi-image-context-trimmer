import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { imageId, projectImages } from "./image-context.ts";

export type ImageProjection = ReturnType<typeof projectImages>;
type Identify = (image: ImageContent) => string | undefined;
export type CachePolicy = { cacheAware: boolean; cacheHorizonRequests: number; maxDeferredBase64Bytes: number; maxCumulativeDeferredBase64Bytes: number };
export const defaultCachePolicy: CachePolicy = { cacheAware: true, cacheHorizonRequests: 4, maxDeferredBase64Bytes: 1024 * 1024, maxCumulativeDeferredBase64Bytes: 4 * 1024 * 1024 };

interface Fingerprint { key: string; tokens: number }
interface MessageFingerprint extends Fingerprint { role: AgentMessage["role"]; parts?: Fingerprint[]; end?: string }
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
  reason: "economic" | "selective" | "deferred" | "bandwidth limit" | "cumulative bandwidth limit" | "window pressure" | "pricing unavailable";
  savedTokensPerRequest: number;
  invalidatedRetainedTokens: number;
  horizonRequests: number;
  estimatedRewriteCost?: number;
  estimatedReadSavings?: number;
  breakEvenRequests?: number;
  deferredBase64Bytes: number;
}

function hash(value: unknown, identify: Identify): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return { type: "image", id: identify(item) ?? imageId(item) };
    }
    return item;
  })).digest("hex");
}

function fingerprint(message: AgentMessage, identify: Identify): MessageFingerprint {
  // User images retain content-block order in the supported serializers.
  if (message.role === "user" && Array.isArray(message.content)) {
    const parts = message.content.map((block, j) => ({
      key: hash([message.role, message.timestamp, j, block], identify),
      tokens: estimateTokens({ ...message, content: [block] }),
    }));
    return { role: message.role, key: `user:${message.timestamp}:${parts.map(part => part.key).join(":")}`, tokens: sumTokens(parts), parts, end: `user-end:${message.timestamp}` };
  }
  const visible = message.role === "toolResult" ? { role: message.role, timestamp: message.timestamp, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, content: message.content } :
    message.role === "assistant" ? { role: message.role, timestamp: message.timestamp, model: message.model, content: message.content } : message;
  return { role: message.role, key: hash(visible, identify), tokens: estimateTokens(message) };
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

function cacheSegments(messages: readonly MessageFingerprint[]) {
  const segments: Fingerprint[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    offsets[i] = segments.length;
    if (message.role === "toolResult") {
      // Tool serializers may regroup text and images across consecutive results.
      const keys: string[] = [];
      let tokens = 0;
      do {
        offsets[i] = segments.length;
        keys.push(messages[i].key);
        tokens += messages[i].tokens;
        i++;
      } while (messages[i]?.role === "toolResult");
      segments.push({ key: `tool:${keys.join(":")}`, tokens });
      i--;
    } else if (message.parts) {
      for (const part of message.parts) segments.push(part);
      segments.push({ key: message.end!, tokens: 0 });
    } else segments.push(message);
  }
  return { segments, offset: (i: number, j: number) => offsets[i] + (messages[i].parts ? j : 0) };
}

function prefixLength(a: Fingerprint[], b: Fingerprint[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i].key === b[i].key) i++;
  return i;
}
const sumTokens = (messages: readonly Fingerprint[]) => messages.reduce((sum, message) => sum + message.tokens, 0);

function ratesFor(model: Pick<Model<string>, "cost">, inputTokens: number) {
  let rates: { input: number; output: number; cacheRead: number; cacheWrite: number } = model.cost;
  let threshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  return rates;
}

/** Compare extra cache reconstruction with future cached reads avoided, in catalog-price dollars. */
export function estimateCacheDecision(input: {
  savedTokensPerRequest: number; invalidatedRetainedTokens: number; horizonRequests: number; bytes: number;
  readRate: number; coldRate: number; maxDeferredBase64Bytes: number; windowPressure: boolean;
  projectedPricing?: { keepInput: number; trimInput: number; keepWarm: number; trimWarm: number; trimReadRate: number; trimColdRate: number };
}): CacheDecision {
  const { savedTokensPerRequest, invalidatedRetainedTokens, horizonRequests, projectedPricing: pricing } = input;
  const validRate = (read: number, cold: number) => Number.isFinite(read) && read >= 0 && Number.isFinite(cold) && cold > 0;
  const validRates = validRate(input.readRate, input.coldRate) && (!pricing || validRate(pricing.trimReadRate, pricing.trimColdRate));
  const rewrite = !validRates ? undefined : pricing
    ? Math.max(0, (pricing.trimInput - pricing.trimWarm) * Math.max(0, pricing.trimColdRate - pricing.trimReadRate) -
      (pricing.keepInput - pricing.keepWarm) * Math.max(0, input.coldRate - input.readRate)) / 1e6
    : invalidatedRetainedTokens * Math.max(0, input.coldRate - input.readRate) / 1e6;
  const savingPerRequest = !validRates ? undefined : pricing
    ? (pricing.keepInput * input.readRate - pricing.trimInput * pricing.trimReadRate) / 1e6
    : savedTokensPerRequest * input.readRate / 1e6;
  const savings = savingPerRequest === undefined ? undefined : savingPerRequest * horizonRequests;
  const payback = rewrite === 0 && savingPerRequest !== undefined && savingPerRequest >= 0 ? 0 :
    rewrite !== undefined && savingPerRequest !== undefined && savingPerRequest > 0 ? rewrite / savingPerRequest : undefined;
  const reason = input.windowPressure ? "window pressure" : input.bytes >= input.maxDeferredBase64Bytes ? "bandwidth limit" :
    rewrite === undefined || savings === undefined ? "pricing unavailable" : savings >= rewrite ? "economic" : "deferred";
  return { reason, savedTokensPerRequest, invalidatedRetainedTokens, horizonRequests, estimatedRewriteCost: rewrite,
    estimatedReadSavings: savings, breakEvenRequests: payback, deferredBase64Bytes: reason === "deferred" ? input.bytes : 0 };
}

export function chooseProjection(raw: AgentMessage[], full: ImageProjection, identify: Identify, previous: WarmProjection | undefined,
  model: Pick<Model<string>, "cost" | "contextWindow">, policy: CachePolicy, windowPressure: boolean, now = Date.now(), cumulativeDeferredBytes = 0): { projection: ImageProjection; snapshot?: ProjectionSnapshot; decision?: CacheDecision } {
  if (!policy.cacheAware) return { projection: full };
  const hasImages = raw.some(message => (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) && message.content.some(block => block.type === "image"));
  if (!hasImages) return { projection: full };
  const candidate = snapshotProjection(raw, full.messages, identify);
  if (!full.omittedImages || !previous) return { projection: full, snapshot: candidate };
  // Five minutes bounds stale-cache assumptions; a reported hit or write is evidence, not a guarantee.
  if (now - previous.at > 5 * 60_000 || (previous.usage.cacheRead <= 0 && previous.usage.cacheWrite <= 0)) return { projection: full, snapshot: candidate };
  const deployed = (i: number, j: number) => previous.raw[i]?.key === candidate.raw[i].key && previous.omitted.has(blockKey(i, j));
  if ([...candidate.omitted].every(key => {
    const [i, j] = key.split(":").map(Number);
    return deployed(i, j);
  })) return { projection: full, snapshot: candidate };
  const stableMask = (i: number, j: number, _active: boolean, mandatory: boolean) => candidate.omitted.has(blockKey(i, j)) && (mandatory || deployed(i, j));
  // Keep active duplicates, historical copies of active images, and already deployed references trimmed.
  const stable = projectImages(raw, () => true, identify, stableMask);
  const bytes = full.omittedBase64Bytes - stable.omittedBase64Bytes;
  if (bytes <= 0) return { projection: full, snapshot: candidate };
  const previousInput = previous.usage.input + previous.usage.cacheRead + previous.usage.cacheWrite;
  if (!Number.isFinite(previousInput) || previousInput <= 0) return { projection: full, snapshot: candidate };
  const retained = snapshotProjection(raw, stable.messages, identify, candidate.raw);
  const rawSegments = cacheSegments(retained.sent);
  const trimmedSegments = cacheSegments(candidate.sent).segments;
  const previousSegments = cacheSegments(previous.sent).segments;
  const keepPrefix = prefixLength(previousSegments, rawSegments.segments);
  const scale = previousInput / Math.max(1, sumTokens(previousSegments));
  const bytesBySegment = new Array<number>(rawSegments.segments.length).fill(0);
  for (const key of candidate.omitted) {
    if (retained.omitted.has(key)) continue;
    const [i, j] = key.split(":").map(Number);
    const message = raw[i];
    if ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)) {
      const block = message.content[j];
      if (block.type === "image") bytesBySegment[rawSegments.offset(i, j)] += block.data.length;
    }
  }
  const prefixTokens = [0], prefixSavings = [0];
  for (let i = 0; i < rawSegments.segments.length; i++) {
    prefixTokens.push(prefixTokens[i] + rawSegments.segments[i].tokens);
    prefixSavings.push(prefixSavings[i] + rawSegments.segments[i].tokens - trimmedSegments[i].tokens);
  }
  const keepInput = Math.ceil(prefixTokens.at(-1)! * scale);
  const keepWarm = Math.min(keepInput, Math.ceil(prefixTokens[keepPrefix] * scale));
  const keepRates = ratesFor(model, keepInput);
  const coldRate = (rates: ReturnType<typeof ratesFor>) => previous.longCacheWriteSeen || (previous.usage.cacheWrite1h ?? 0) > 0 ? Math.max(rates.input * 2, rates.cacheWrite) : previous.cacheWriteSeen || previous.usage.cacheWrite > 0 ? Math.max(rates.input, rates.cacheWrite) : rates.input;
  const limitReason = (deferred: number): CacheDecision["reason"] | undefined => deferred <= 0 ? undefined :
    deferred >= policy.maxDeferredBase64Bytes ? "bandwidth limit" :
    cumulativeDeferredBytes + deferred > policy.maxCumulativeDeferredBase64Bytes ? "cumulative bandwidth limit" : undefined;
  // Every possible earliest replacement defines a suffix. Evaluate these with cumulative sums, then project once.
  type Cut = { index: number; bytes: number; decision: CacheDecision };
  let fullCut: Cut | undefined, economicCut: Cut | undefined, budgetCut: Cut | undefined, suffixBytes = 0;
  for (let i = rawSegments.segments.length - 1; i >= 0; i--) {
    if (!bytesBySegment[i]) continue;
    suffixBytes += bytesBySegment[i];
    const saved = Math.max(0, Math.floor((prefixSavings.at(-1)! - prefixSavings[i]) * Math.min(1, scale)));
    const trimInput = Math.max(0, keepInput - saved);
    const trimWarm = Math.min(trimInput, Math.ceil(prefixTokens[Math.min(i, keepPrefix)] * scale));
    const removedFromPrefix = i < keepPrefix ? Math.floor((prefixSavings[keepPrefix] - prefixSavings[i]) * Math.min(1, scale)) : 0;
    const trimRates = ratesFor(model, trimInput);
    const decision = estimateCacheDecision({ savedTokensPerRequest: saved,
      invalidatedRetainedTokens: Math.max(0, keepWarm - trimWarm - removedFromPrefix), horizonRequests: policy.cacheHorizonRequests,
      bytes: suffixBytes, readRate: keepRates.cacheRead, coldRate: coldRate(keepRates), maxDeferredBase64Bytes: Infinity, windowPressure: false,
      projectedPricing: { keepInput, trimInput, keepWarm, trimWarm, trimReadRate: trimRates.cacheRead, trimColdRate: coldRate(trimRates) } });
    const cut = { index: i, bytes: suffixBytes, decision };
    fullCut = cut;
    if (decision.reason === "economic") economicCut = cut;
    if (!budgetCut && !limitReason(bytes - suffixBytes)) budgetCut = cut;
  }
  if (!fullCut) return { projection: full, snapshot: candidate };
  let chosen = economicCut;
  let reason: CacheDecision["reason"] | undefined;
  if (windowPressure || fullCut.decision.reason === "pricing unavailable") {
    chosen = fullCut;
    reason = windowPressure ? "window pressure" : "pricing unavailable";
  } else if (policy.maxDeferredBase64Bytes === 0 || policy.maxCumulativeDeferredBase64Bytes === 0) {
    chosen = fullCut;
    reason = policy.maxDeferredBase64Bytes === 0 ? "bandwidth limit" : "cumulative bandwidth limit";
  } else {
    reason = limitReason(bytes - (chosen?.bytes ?? 0));
    if (reason) chosen = budgetCut ?? fullCut;
  }
  if (!chosen) return { projection: stable, snapshot: retained, decision: { ...fullCut.decision, reason: "deferred", deferredBase64Bytes: bytes } };
  const deferredBase64Bytes = bytes - chosen.bytes;
  const decision: CacheDecision = { ...chosen.decision, reason: reason ?? (deferredBase64Bytes ? "selective" : "economic"), deferredBase64Bytes };
  if (!deferredBase64Bytes) return { projection: full, snapshot: candidate, decision };
  const projection = projectImages(raw, () => true, identify, (i, j, active, mandatory) => candidate.omitted.has(blockKey(i, j)) &&
    (stableMask(i, j, active, mandatory) || rawSegments.offset(i, j) >= chosen.index));
  return { projection, snapshot: snapshotProjection(raw, projection.messages, identify, candidate.raw), decision };
}
