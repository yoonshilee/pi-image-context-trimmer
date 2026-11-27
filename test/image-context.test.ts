import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage, type ImageContent, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { findImage, imageId, projectImages, supportsProjection } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ ...fauxAssistantMessage("ok"), stopReason } as AssistantMessage);
const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "call", toolName: "recall_context_image", content: [image], isError: false, timestamp: 3 };
const countImages = (messages: readonly AgentMessage[], target = image) => JSON.stringify(messages).split(target.data).length - 1;
const secondImage = { ...image, data: Buffer.alloc(1024, 1).toString("base64") };
const thirdImage = { ...image, data: Buffer.alloc(1024, 2).toString("base64") };
const result = (target: ImageContent, id: string): ToolResultMessage => ({ ...toolResult, toolCallId: id, content: [target] });

test("first image survives, completed history becomes a recoverable reference without mutating session data", () => {
  const original = [user([{ type: "text", text: "inspect" }, image])];
  assert.equal(countImages(projectImages(original, () => true).messages), 1);
  const history = [...original, assistant(), user("next")];
  const projected = projectImages(history, () => true);
  assert.equal(projected.omittedImages, 1);
  assert.equal(projected.omittedBase64Bytes, image.data.length);
  assert.equal(countImages(projected.messages), 0);
  assert.equal(countImages(history), 1);
  assert.match(JSON.stringify(projected.messages), new RegExp(imageId(image)));
  assert.equal(findImage(history, imageId(image)), image);
  assert.equal(findImage(history, "unknown"), undefined);
});

test("distinct images remain available throughout the active retrieval loop", () => {
  const history = [user("audit"), assistant("toolUse"), result(image, "a"), assistant("toolUse"), result(secondImage, "b"), assistant("toolUse"), result(thirdImage, "c")];
  const active = projectImages(history, () => true);
  assert.equal(active.omittedImages, 0);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(active.messages, target), 1);
  const continued = projectImages([...history, assistant()], () => true);
  assert.equal(continued.omittedImages, 0, "same user turn must retain evidence even after an assistant stop");
  const next = projectImages([...history, assistant(), user("next task")], () => true);
  assert.equal(next.omittedImages, 3);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("multiple recalled images stay together until the next completed user turn", () => {
  const history = [user([image, secondImage]), assistant(), user("compare"), assistant("toolUse"), result(image, "recall-a"), assistant("toolUse"), result(secondImage, "recall-b"), assistant("toolUse"), result(thirdImage, "new-c"), assistant("toolUse"), result(image, "repeat-a")];
  const projected = projectImages(history, () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
  assert.equal(projected.omittedImages, 3, "historical originals and the duplicate active image become references");
  const next = projectImages([...history, assistant(), user("next")], () => true);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(next.messages, target), 0);
});

test("steering and failed turns do not discard unfinished visual evidence", () => {
  const history = [user([image]), assistant("toolUse"), result(secondImage, "b"), assistant("error"), user("retry with this"), assistant("toolUse"), result(thirdImage, "c")];
  const projected = projectImages(history, () => true);
  assert.equal(projected.omittedImages, 0);
  for (const target of [image, secondImage, thirdImage]) assert.equal(countImages(projected.messages, target), 1);
  const continuation = [user([image]), assistant(), assistant("toolUse"), result(secondImage, "b"), assistant("error"), user("retry")];
  const continued = projectImages(continuation, () => true);
  assert.equal(continued.omittedImages, 0, "a stop followed by an unfinished continuation is not a completed turn");
});

test("a failed response, unavailable source, small image and unsupported transport are not trimmed", () => {
  const history = [user([image]), assistant("error"), user("retry")];
  assert.equal(countImages(projectImages(history, () => true).messages), 1);
  assert.equal(countImages(projectImages([...history, assistant()], () => false).messages), 1);
  assert.equal(projectImages([user([{ ...image, data: "aA==" }]), assistant()], () => true).omittedImages, 0);
  assert.equal(supportsProjection("openai-codex-responses"), false);
  assert.equal(supportsProjection("openai-codex-responses", "sse"), true);
  assert.equal(supportsProjection("anthropic-messages"), true);
  assert.equal(supportsProjection("google-generative-ai"), false);
});

test("duplicate fresh blocks are transmitted once", () => {
  const projected = projectImages([user([image, image])], () => true);
  assert.equal(projected.omittedImages, 1);
  assert.equal(countImages(projected.messages), 1);
});
