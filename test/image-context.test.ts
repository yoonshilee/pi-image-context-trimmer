import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage, type ImageContent, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { findImage, imageId, projectImages, RECALL_TOOL, supportsProjection } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ ...fauxAssistantMessage("ok"), stopReason } as AssistantMessage);
const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "call", toolName: "read_image", content: [image], isError: false, timestamp: 3 };
const countImages = (messages: readonly AgentMessage[], target = image) => JSON.stringify(messages).split(target.data).length - 1;
const secondImage = { ...image, data: Buffer.alloc(1024, 1).toString("base64") };
const thirdImage = { ...image, data: Buffer.alloc(1024, 2).toString("base64") };
const result = (target: ImageContent, id: string, toolName = toolResult.toolName): ToolResultMessage => ({ ...toolResult, toolCallId: id, toolName, content: [target] });

test("first image survives, a successful request permits trimming without another user turn or session mutation", () => {
  const original = [user([{ type: "text", text: "inspect" }, image])];
  assert.equal(countImages(projectImages(original, () => true).messages), 1);
  const history = [...original, assistant("toolUse")];
  const projected = projectImages(history, () => true);
  assert.equal(projected.omittedImages, 1);
  assert.equal(projected.omittedBase64Bytes, image.data.length);
  assert.equal(countImages(projected.messages), 0);
  assert.equal(countImages(history), 1);
  assert.match(JSON.stringify(projected.messages), new RegExp(imageId(image)));
  assert.equal(findImage(history, imageId(image)), image);
  assert.equal(findImage(history, "unknown"), undefined);
});

test("only new images are sent after each successful request in the same retrieval loop", () => {
  const history = [user("audit"), assistant("toolUse"), result(image, "a"), assistant("toolUse"), result(secondImage, "b"), assistant("toolUse"), result(thirdImage, "c")];
  const active = projectImages(history, () => true);
  assert.equal(active.omittedImages, 2);
  assert.equal(countImages(active.messages), 0);
  assert.equal(countImages(active.messages, secondImage), 0);
  assert.equal(countImages(active.messages, thirdImage), 1);
  const continued = projectImages([...history, assistant()], () => true);
  assert.equal(continued.omittedImages, 3);
  const next = projectImages([...history, assistant(), user("next task")], () => true);
  assert.equal(next.omittedImages, 3);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("multiple new or explicitly recalled images are sent together until a successful response", () => {
  const initial = [user([image, secondImage, thirdImage])];
  const fresh = projectImages(initial, () => true);
  assert.equal(fresh.omittedImages, 0);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(fresh.messages, target), 1);
  const history = [...initial, assistant("toolUse"), result(image, "recall-a", RECALL_TOOL), result(secondImage, "recall-b", RECALL_TOOL), result(image, "repeat-a", RECALL_TOOL)];
  const projected = projectImages(history, () => true);
  for (const target of [image, secondImage]) assert.equal(countImages(projected.messages, target), 1);
  assert.equal(countImages(projected.messages, thirdImage), 0);
  assert.equal(projected.omittedImages, 4, "processed originals and the duplicate recall become references");
  const next = projectImages([...history, assistant(), user("next")], () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("errors, aborts, output limits and steering retain images without a successful response", () => {
  for (const reason of ["error", "aborted", "length"] as const) {
    const history = [user([image]), assistant("toolUse"), result(secondImage, "b"), assistant(reason), user("retry with this"), result(thirdImage, "c")];
    const projected = projectImages(history, () => true);
    assert.equal(projected.omittedImages, 1);
    assert.equal(countImages(projected.messages), 0);
    for (const target of [secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
    assert.deepEqual(projectImages(history, () => true), projected, "repeated preparation must not mark pending images as processed");
  }
  assert.equal(projectImages([user([image]), user("additional instructions")], () => true).omittedImages, 0);
});

test("repeated tool reads reuse references but an explicit recall resends the original once", () => {
  const history = [user("read"), assistant("toolUse"), result(image, "first"), assistant("toolUse"), result(image, "repeat")];
  const repeated = projectImages(history, () => true);
  assert.equal(countImages(repeated.messages), 0);
  assert.equal(repeated.omittedImages, 2);
  assert.match(JSON.stringify(repeated.messages.at(-1)), new RegExp(RECALL_TOOL));
  const recalled = [...history, assistant("toolUse"), result(image, "recall", RECALL_TOOL)];
  assert.equal(countImages(projectImages(recalled, () => true).messages), 1);
  assert.equal(countImages(projectImages([...recalled, assistant("toolUse")], () => true).messages), 0);
  const failedRecall = [...recalled, assistant("error")];
  assert.equal(countImages(projectImages(failedRecall, () => true).messages), 1);
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
  assert.match(JSON.stringify(projected.messages.at(-1)), /already included earlier/);
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
