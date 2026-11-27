import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage, type ImageContent, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { findImage, imageId, indexSourceImages, projectImages, RECALL_TOOL, supportsProjection } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ ...fauxAssistantMessage("ok"), stopReason } as AssistantMessage);
const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "call", toolName: "read_image", content: [image], isError: false, timestamp: 3 };
const countImages = (messages: readonly AgentMessage[], target = image) => JSON.stringify(messages).split(target.data).length - 1;
const secondImage = { ...image, data: Buffer.alloc(1024, 1).toString("base64") };
const thirdImage = { ...image, data: Buffer.alloc(1024, 2).toString("base64") };
const result = (target: ImageContent, id: string, toolName = toolResult.toolName): ToolResultMessage => ({ ...toolResult, toolCallId: id, toolName, content: [target] });

test("current-task images remain visible across successful tool calls without mutating the session", () => {
  const original = [user([{ type: "text", text: "inspect" }, image])];
  const history = [...original, assistant("toolUse")];
  assert.equal(countImages(projectImages(original, () => true).messages), 1);
  const active = projectImages(history, () => true);
  assert.equal(active.omittedImages, 0);
  assert.equal(countImages(active.messages), 1);
  const next = projectImages([...history, assistant(), user("next")], () => true);
  assert.equal(next.omittedImages, 1);
  assert.equal(next.omittedBase64Bytes, image.data.length);
  assert.equal(countImages(next.messages), 0);
  assert.equal(countImages(history), 1);
  assert.match(JSON.stringify(next.messages), new RegExp(imageId(image)));
  assert.equal(findImage(history, imageId(image)), image);
  assert.equal(findImage(history, "unknown"), undefined);
});

test("linked retrieval retains distinct images for comparison throughout the same user task", () => {
  const history = [user("audit"), assistant("toolUse"), result(image, "a"), assistant("toolUse"), result(secondImage, "b"), assistant("toolUse"), result(thirdImage, "c")];
  const active = projectImages(history, () => true);
  assert.equal(active.omittedImages, 0);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(active.messages, target), 1);
  assert.deepEqual(projectImages([...history, assistant()], () => true).messages.slice(0, history.length), active.messages);
  const next = projectImages([...history, assistant(), user("next task")], () => true);
  assert.equal(next.omittedImages, 3);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("recalls of active images are deduplicated, preserving the first visible copy", () => {
  const initial = [user([image, secondImage, thirdImage])];
  const history = [...initial, assistant("toolUse"), result(image, "recall-a", RECALL_TOOL), result(secondImage, "recall-b", RECALL_TOOL), result(image, "repeat-a", RECALL_TOOL)];
  const projected = projectImages(history, () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
  assert.equal(projected.omittedImages, 3);
  assert.deepEqual(projected.messages[0], initial[0]);
  const next = projectImages([...history, assistant(), user("next")], () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("errors, aborts, output limits and steering retain all active visual evidence", () => {
  for (const reason of ["error", "aborted", "length"] as const) {
    const history = [user([image]), assistant("toolUse"), result(secondImage, "b"), assistant(reason), user("retry with this"), result(thirdImage, "c")];
    const projected = projectImages(history, () => true);
    assert.equal(projected.omittedImages, 0);
    for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
    assert.deepEqual(projectImages(history, () => true), projected);
  }
  assert.equal(projectImages([user([image]), user("additional instructions")], () => true).omittedImages, 0);
});

test("repeated tool reads deduplicate active images; fresh reads and attachments restore historical images", () => {
  const history = [user("read"), assistant("toolUse"), result(image, "first"), assistant("toolUse"), result(image, "repeat")];
  const repeated = projectImages(history, () => true);
  assert.equal(countImages(repeated.messages), 1);
  assert.equal(repeated.omittedImages, 1);
  assert.deepEqual(repeated.messages.slice(0, 3), history.slice(0, 3));
  const completed = [...history, assistant(), user("inspect again")];
  assert.equal(countImages(projectImages(completed, () => true).messages), 0);
  for (const fresh of [user([image]), result(image, "read-again"), result(image, "recall", RECALL_TOOL)]) {
    const active = [...completed, fresh, assistant("toolUse")];
    const projected = projectImages(active, () => true);
    assert.equal(countImages(projected.messages), 1);
    assert.deepEqual(projected.messages.at(-2), fresh);
    assert.equal(projected.omittedImages, 2);
  }
});

test("a failed response, unavailable source, small image and unsupported transport are not trimmed", () => {
  const history = [user([image]), assistant("error"), user("retry")];
  assert.equal(countImages(projectImages(history, () => true).messages), 1);
  assert.equal(countImages(projectImages([user([image]), assistant(), user("next")], () => false).messages), 1);
  assert.equal(projectImages([user([{ ...image, data: "aA==" }]), assistant(), user("next")], () => true).omittedImages, 0);
  const codex = { api: "openai-codex-responses", baseUrl: "https://example.test" };
  assert.equal(supportsProjection(codex), false);
  assert.equal(supportsProjection(codex, "sse"), true);
  assert.equal(supportsProjection({ api: "google-generative-ai", baseUrl: "https://example.test" }), false);
});

test("duplicate fresh blocks are transmitted once", () => {
  const projected = projectImages([user([image, image])], () => true);
  assert.equal(projected.omittedImages, 1);
  assert.equal(countImages(projected.messages), 1);
});

test("stateless Messages APIs are supported but native incremental threads are bypassed", () => {
  const gateway = { api: "anthropic-messages", baseUrl: "https://example.test/v1" };
  const native = { ...gateway, baseUrl: "https://api.anthropic.com" };
  assert.equal(supportsProjection(gateway), true);
  assert.equal(supportsProjection(native), false);
  assert.equal(supportsProjection({ ...gateway, compat: { supportsMessageThreads: true } }), false);
  assert.equal(supportsProjection({ ...native, compat: { supportsMessageThreads: false } }), true);
});

test("duplicate pending tool images do not rewrite the first visible copy", () => {
  const history = [user("read"), assistant("toolUse"), result(image, "first")];
  const previous = projectImages(history, () => true).messages;
  const projected = projectImages([...history, result(image, "repeat")], () => true);
  assert.deepEqual(projected.messages.slice(0, history.length), previous);
  assert.equal(countImages(projected.messages), 1);
  assert.match(JSON.stringify(projected.messages.at(-1)), /already included earlier/i);
});

test("image IDs reuse digests without returning stale hashes for changed content", t => {
  const create = t.mock.method(crypto, "createHash");
  syncBuiltinESMExports();
  try {
    const mutable = { ...image };
    const before = imageId(mutable);
    assert.equal(imageId(mutable), before);
    assert.equal(create.mock.callCount(), 1);
    mutable.data = secondImage.data;
    assert.notEqual(imageId(mutable), before);
    assert.equal(create.mock.callCount(), 2);
    assert.equal(imageId(mutable), imageId(secondImage));
  } finally {
    create.mock.restore();
    syncBuiltinESMExports();
  }
});


test("sequential recalls accumulate visual evidence across tool calls and release it after task completion", () => {
  const history = [user([image, secondImage, thirdImage]), assistant(), user("compare again"), assistant("toolUse"), result(image, "recall-a", RECALL_TOOL), assistant("toolUse"), result(secondImage, "recall-b", RECALL_TOOL), assistant("toolUse"), result(thirdImage, "recall-c", RECALL_TOOL)];
  const projected = projectImages(history, () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
  const continued = projectImages([...history, assistant("toolUse")], () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(continued.messages, target), 1);
  const next = projectImages([...history, assistant(), user("next task")], () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});


test("source lookup reuses hashes across Pi context clones and rejects changed or off-branch images", t => {
  const create = t.mock.method(crypto, "createHash");
  syncBuiltinESMExports();
  try {
    const source = { ...image, data: Buffer.alloc(65536, 7).toString("base64") };
    const history = [user([source]), assistant(), user("next")];
    for (let i = 0; i < 5; i++) {
      const lookup = indexSourceImages(history);
      const projected = projectImages(structuredClone(history), () => true, lookup);
      assert.equal(projected.omittedImages, 1);
      assert.equal(create.mock.callCount(), 1, "only hash the original stable image object");
      assert.equal(lookup({ ...source, mimeType: "image/jpeg" }), undefined);
      assert.equal(lookup({ ...source, data: secondImage.data }), undefined);
    }
    const offBranch = projectImages(structuredClone(history), () => true, indexSourceImages([]));
    assert.equal(offBranch.omittedImages, 0);
    assert.deepEqual(offBranch.messages, history);
  } finally {
    create.mock.restore();
    syncBuiltinESMExports();
  }
});
