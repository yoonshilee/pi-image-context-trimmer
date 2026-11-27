import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import { chooseProjection, defaultCachePolicy, estimateCacheDecision, snapshotProjection } from "../src/cache-economics.ts";
import { estimateMessageTokens, thresholdDeferral } from "../src/compaction.ts";
import { imageId, projectImages } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: string | ImageContent[], timestamp: number): AgentMessage => ({ role: "user", timestamp, content });
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
