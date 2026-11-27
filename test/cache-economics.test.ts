import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, type Usage, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { chooseProjection, defaultCachePolicy, estimateCacheDecision, snapshotProjection } from "../src/cache-economics.ts";
import { estimateMessageTokens, thresholdDeferral } from "../src/compaction.ts";
import { imageId, projectImages } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: UserMessage["content"], timestamp: number): AgentMessage => ({ role: "user", timestamp, content });
const answer = (timestamp: number, usage?: Usage): AgentMessage => ({ ...fauxAssistantMessage("Done."), timestamp, stopReason: "stop", ...(usage ? { usage } : {}) });
const usage: Usage = { input: 1000, cacheRead: 8000, cacheWrite: 0, output: 10, totalTokens: 9010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, contextWindow: 100000 };
const choices = { savedTokensPerRequest: 1000, invalidatedRetainedTokens: 10000, horizonRequests: 4, bytes: 1024, readRate: 0.1, coldRate: 2, maxDeferredBase64Bytes: 1024 * 1024, windowPressure: false };

test("economic decision compares cache reconstruction with avoided reads and honors pressure overrides", () => {
  const delayed = estimateCacheDecision(choices);
  assert.equal(delayed.reason, "deferred");
  assert.equal(delayed.breakEvenRequests, 190);
  assert.equal(delayed.deferredBase64Bytes, 1024);
  assert.equal(estimateCacheDecision({ ...choices, horizonRequests: 200 }).reason, "economic");
  assert.equal(estimateCacheDecision({ ...choices, windowPressure: true }).reason, "window pressure");
  assert.equal(estimateCacheDecision({ ...choices, maxDeferredBase64Bytes: 1024 }).reason, "bandwidth limit");
  assert.equal(estimateCacheDecision({ ...choices, readRate: 0 }).reason, "deferred");
  assert.equal(estimateCacheDecision({ ...choices, coldRate: 0 }).reason, "pricing unavailable");
});

test("applied references stay stable while a newly eligible costly replacement is deferred", () => {
  const first = [user([image], 1), answer(2), user([image], 3), user("long evidence ".repeat(2000), 4)];
  const old = projectImages(first, () => true);
  assert.equal(old.omittedImages, 1);
  const previous = { ...snapshotProjection(first, old.messages, imageId), usage, at: 100 };
  const raw = [...structuredClone(first), answer(5), user("Continue", 6)];
  const full = projectImages(raw, () => true);
  const chosen = chooseProjection(raw, full, imageId, previous, model, defaultCachePolicy, false, 101);
  assert.equal(chosen.decision?.reason, "deferred");
  assert.equal(chosen.projection.omittedImages, 1);
  assert.deepEqual(chosen.projection.messages[0], old.messages[0]);
  assert.equal(chooseProjection(raw, full, imageId, previous, model, defaultCachePolicy, true, 101).projection.omittedImages, 2);
  assert.equal(chooseProjection(raw, full, imageId, previous, model, defaultCachePolicy, false, 400000).projection.omittedImages, 2);
});

test("threshold guard credits purely estimated images but never subtracts historical images twice from reported usage", () => {
  const raw = [user([image, image, image, image], 1), answer(2), user("next", 3)];
  const trimmed = projectImages(raw, () => true).messages;
  const before = estimateMessageTokens(raw);
  assert.equal(thresholdDeferral(raw, trimmed, before, 2400, 500).defer, true);
  const measured = [user([image, image, image, image], 1), answer(2, usage), user("next", 3)];
  assert.equal(thresholdDeferral(measured, projectImages(measured, () => true).messages, 9012, 10000, 1000).defer, false);
  assert.equal(thresholdDeferral(raw, raw, before, 2400, 500).defer, false);
});


const small = { ...image, data: Buffer.alloc(12 * 1024, 1).toString("base64") };
const large = { ...image, data: Buffer.alloc(128 * 1024, 2).toString("base64") };
const longEvidence = "long evidence ".repeat(2000);
const warm = (messages: AgentMessage[], observedUsage = usage) => ({
  ...snapshotProjection(messages, messages, imageId), usage: observedUsage, at: 100,
});

function currentProjection(previous: AgentMessage[]) {
  return [...previous, answer(4), user("Continue", 5)];
}

const visibleImages = (messages: AgentMessage[]) => messages.flatMap(message =>
  (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
    ? message.content.filter(block => block.type === "image") : []);

test("selective trimming keeps an expensive early cache prefix and removes a cheap later image", () => {
  const first = [user([small], 1), user(longEvidence, 2), user([large], 3)];
  const raw = currentProjection(first);
  const full = projectImages(raw, () => true);
  const choice = chooseProjection(raw, full, imageId, warm(first), model, defaultCachePolicy, false, 101);
  assert.equal(full.omittedBase64Bytes, 191148);
  assert.equal(choice.projection.omittedBase64Bytes, 174764);
  assert.equal(choice.decision?.reason, "selective");
  assert.equal(choice.decision.deferredBase64Bytes, 16384);
  assert.deepEqual(visibleImages(choice.projection.messages), [small]);
  assert.deepEqual(visibleImages(raw), [small, large]);
  const resumed = { ...choice.snapshot!, usage, at: 101 };
  const followUp = [...raw, answer(6), user("Again", 7)];
  const next = chooseProjection(followUp, projectImages(followUp, () => true), imageId, resumed, model, defaultCachePolicy, false, 102);
  assert.equal(next.projection.omittedBase64Bytes, 174764, "the deployed later reference stays stable");
});

test("unchanged text before an image within the same user message remains cacheable", () => {
  const first = [user([{ type: "text", text: longEvidence }, small], 1)];
  const raw = currentProjection(first);
  const choice = chooseProjection(raw, projectImages(raw, () => true), imageId, warm(first), model, defaultCachePolicy, false, 101);
  assert.equal(choice.projection.omittedImages, 1);
  assert.equal(choice.decision?.reason, "economic");
  const separate = [user(longEvidence, 1), user([small], 2)];
  const separatedRaw = currentProjection(separate);
  const separated = chooseProjection(separatedRaw, projectImages(separatedRaw, () => true), imageId, warm(separate), model, defaultCachePolicy, false, 101);
  assert.equal(choice.decision.invalidatedRetainedTokens, separated.decision?.invalidatedRetainedTokens, "unchanged text preceding the image is not invalidated by sharing the user message");
});

test("consecutive tool results are conservative cache boundaries because their images may be grouped after text", () => {
  const tool = (id: string, content: ToolResultMessage["content"]): ToolResultMessage => ({ role: "toolResult" as const, toolCallId: id, toolName: "read", content, timestamp: 2, isError: false });
  const first: AgentMessage[] = [user("Read", 1), tool("first", [{ type: "text", text: longEvidence }]), tool("second", [small])];
  const raw = currentProjection(first);
  const choice = chooseProjection(raw, projectImages(raw, () => true), imageId, warm(first), model, defaultCachePolicy, false, 101);
  assert.equal(choice.projection.omittedImages, 0);
  assert.equal(choice.decision?.reason, "deferred");
});

test("cumulative deferred bytes are bounded even across one hundred follow-up requests", () => {
  const first = [user([small], 1), user(longEvidence, 2)];
  const policy = { ...defaultCachePolicy, maxCumulativeDeferredBase64Bytes: 3 * small.data.length };
  let raw = currentProjection(first);
  let previous = warm(first);
  let deferred = 0;
  let forced = 0;
  for (let i = 0; i < 100; i++) {
    const choice = chooseProjection(raw, projectImages(raw, () => true), imageId, previous, model, policy, false, 101 + i, deferred);
    deferred += choice.decision?.deferredBase64Bytes ?? 0;
    if (choice.decision?.reason === "cumulative bandwidth limit") forced++;
    previous = { ...choice.snapshot!, usage, at: 101 + i };
    raw = [...raw, answer(6 + i * 2), user("Continue", 7 + i * 2)];
  }
  assert.equal(deferred, policy.maxCumulativeDeferredBase64Bytes);
  assert.equal(forced, 1);
  const fresh = currentProjection(first);
  const zero = chooseProjection(fresh, projectImages(fresh, () => true), imageId, warm(first), model, { ...policy, maxCumulativeDeferredBase64Bytes: 0 }, false, 101);
  assert.equal(zero.projection.omittedImages, 1);
  assert.equal(zero.decision?.reason, "cumulative bandwidth limit");
});

test("a reported cache write without a cache read is evidence of a warm prefix", () => {
  const first = [user([small], 1), user(longEvidence, 2)];
  const raw = currentProjection(first);
  const write = { ...usage, input: 1000, cacheRead: 0, cacheWrite: 8000 };
  const choice = chooseProjection(raw, projectImages(raw, () => true), imageId, warm(first, write), model, defaultCachePolicy, false, 101);
  assert.equal(choice.projection.omittedImages, 0);
  assert.equal(choice.decision?.reason, "deferred");
});

test("a newly active attachment forces its identical deferred historical copy to a reference", () => {
  const first = [user([small], 1), user(longEvidence, 2)];
  const raw = [...first, answer(3), user([small], 4)];
  const choice = chooseProjection(raw, projectImages(raw, () => true), imageId, warm(first), model, defaultCachePolicy, false, 101);
  assert.equal(choice.projection.omittedImages, 1);
  assert.deepEqual(choice.projection.messages.at(-1), raw.at(-1));
  assert.deepEqual(visibleImages(choice.projection.messages), [small]);
});

test("projected input pricing tiers can justify trimming before a new request crosses a rate boundary", () => {
  const first = [user([small], 1), user(longEvidence, 2)];
  const raw = [...first, answer(3), user("x".repeat(3000), 4)];
  const full = projectImages(raw, () => true);
  assert.equal(chooseProjection(raw, full, imageId, warm(first), model, defaultCachePolicy, false, 101).decision?.reason, "deferred");
  const tiered = { ...model, cost: { ...model.cost, tiers: [{ inputTokensAbove: 9500, input: 4, output: 10, cacheRead: 0.5, cacheWrite: 5 }] } };
  const choice = chooseProjection(raw, full, imageId, warm(first), tiered, defaultCachePolicy, false, 101);
  assert.equal(choice.projection.omittedImages, 1);
  assert.equal(choice.decision?.reason, "economic");
});
