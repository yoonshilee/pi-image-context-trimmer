import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage, type ImageContent, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { findImage, imageId, projectImages, supportsProjection } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.alloc(1024).toString("base64") };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ ...fauxAssistantMessage("ok"), stopReason } as AssistantMessage);
const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "call", toolName: "recall_context_image", content: [image], isError: false, timestamp: 3 };
const countImages = (messages: readonly AgentMessage[]) => JSON.stringify(messages).split(image.data).length - 1;

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

test("recall uploads once; subsequent requests contain only references", () => {
  const history = [user([image]), assistant("toolUse"), toolResult];
  const projected = projectImages(history, () => true);
  assert.equal(countImages(projected.messages), 1);
  assert.equal(projected.omittedImages, 1);
  assert.equal(projected.messages[2], toolResult);
  assert.equal(countImages(projectImages([...history, assistant()], () => true).messages), 0);
});

test("a failed response, unavailable source, small image and unsupported transport are not trimmed", () => {
  const history = [user([image]), assistant("error"), user("retry")];
  assert.equal(countImages(projectImages(history, () => true).messages), 1);
  assert.equal(countImages(projectImages([...history, assistant()], () => false).messages), 1);
  assert.equal(projectImages([user([{ ...image, data: "aA==" }]), assistant()], () => true).omittedImages, 0);
  assert.equal(supportsProjection("openai-codex-responses"), false);
  assert.equal(supportsProjection("openai-codex-responses", "sse"), true);
  assert.equal(supportsProjection("anthropic-messages"), false);
});

test("duplicate fresh blocks are transmitted once", () => {
  const projected = projectImages([user([image, image])], () => true);
  assert.equal(projected.omittedImages, 1);
  assert.equal(countImages(projected.messages), 1);
});
