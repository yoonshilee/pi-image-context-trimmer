import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import { estimateMessageTokens, thresholdDeferral } from "../src/compaction.ts";
import { projectImages } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const usage: Usage = { input: 5000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function seedHistory() {
  const manager = SessionManager.inMemory(process.cwd());
  const userIds = Array.from({ length: 4 }, (_, index) => {
    const id = manager.appendMessage({ role: "user", content: [image], timestamp: index * 2 + 1 });
    manager.appendMessage({ ...fauxAssistantMessage("Done."), timestamp: index * 2 + 2, stopReason: "stop", usage });
    return id;
  });
  return { manager, userIds };
}

function assess(manager: SessionManager, nativeTokens: number, contextWindow = 2400, reserveTokens = 500) {
  const projection = manager.buildSessionProjection();
  const trimmed = projectImages(projection.messages, () => true);
  return thresholdDeferral(projection.messages, trimmed.messages, nativeTokens, contextWindow, reserveTokens,
    { projection, branchEntries: manager.getBranch() });
}

test("a later context edit invalidates measured usage and lets image trimming avoid threshold compaction", () => {
  const { manager, userIds } = seedHistory();
  manager.appendContextEdit(userIds.at(-1)!, { content: [image, { type: "text", text: "modified" }] });
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 9 });
  // Pi's native projected estimator uses its heuristic after the edit (4812 tokens).
  const result = assess(manager, 4812);
  assert.equal(result.defer, true);
  assert(result.savings > 4000);
  assert(result.safeTokens < 500);
});

test("a compaction invalidates usage in its retained history even when the old response is still visible", () => {
  const { manager, userIds } = seedHistory();
  manager.appendCompaction("Earlier work is summarized.", userIds[1], 5010);
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 9 });
  const projection = manager.buildSessionProjection();
  assert(projection.messages.some(message => message.role === "assistant" && message.usage.totalTokens === 5010));
  const result = assess(manager, estimateMessageTokens(projection.messages));
  assert.equal(result.defer, true);
  assert(result.savings > 3000);
});

test("usage captured after the latest edit remains valid, so historical images are not credited twice", () => {
  const { manager, userIds } = seedHistory();
  manager.appendContextEdit(userIds.at(-1)!, { content: [image, { type: "text", text: "modified" }] });
  manager.appendMessage({ role: "user", content: "Check the modification", timestamp: 9 });
  manager.appendMessage({ ...fauxAssistantMessage("Done."), timestamp: 10, stopReason: "stop", usage });
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 11 });
  const result = assess(manager, 5012);
  assert.equal(result.defer, false);
  assert.equal(result.savings, 0);
  assert(result.safeTokens >= 5010);
});

test("without an invalidating entry, measured usage remains the floor even if historical images could be trimmed", () => {
  const { manager } = seedHistory();
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 9 });
  const result = assess(manager, 5012);
  assert.equal(result.defer, false);
  assert.equal(result.savings, 0);
  assert(result.safeTokens >= 5010);
});

test("valid usage permits only savings from duplicate images added after that response", () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
  manager.appendMessage({ ...fauxAssistantMessage("Done."), timestamp: 2, stopReason: "stop", usage: { ...usage, input: 600, totalTokens: 610 } });
  manager.appendMessage({ role: "user", content: [image, image], timestamp: 3 });
  const result = assess(manager, 3010);
  assert.equal(result.defer, true);
  assert(result.savings > 1100 && result.savings < 1200);
  assert(result.safeTokens > 1800 && result.safeTokens <= 1850);
});

test("pure estimates count the effective system prompt, not superseded sections", () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "system", content: "", sections: { instructions: "Prior instructions ".repeat(1000) }, timestamp: 1 });
  manager.appendMessage({ role: "system", content: "", sections: { instructions: "Short instructions" }, timestamp: 2 });
  for (let i = 0; i < 3; i++) {
    manager.appendMessage({ role: "user", content: [image], timestamp: i * 2 + 3 });
    manager.appendMessage({ ...fauxAssistantMessage("Done."), timestamp: i * 2 + 4, stopReason: "stop" });
  }
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 9 });
  const result = assess(manager, 3613);
  assert.equal(result.defer, true);
  assert(result.safeTokens < 500);
});

test("even stale usage cannot allow deferral when the projected context exceeds the safety margin", () => {
  const { manager, userIds } = seedHistory();
  manager.appendContextEdit(userIds.at(-1)!, { content: [image, { type: "text", text: "modified" }] });
  manager.appendMessage({ role: "user", content: "Wait for further instructions. ".repeat(240), timestamp: 9 });
  const projection = manager.buildSessionProjection();
  const result = assess(manager, estimateMessageTokens(projection.messages));
  assert.equal(result.defer, false);
  assert(result.savings > 4000);
  assert(result.safeTokens > result.threshold - 50);
});
