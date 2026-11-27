import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const RECALL_TOOL = "recall_context_image";

const imageIds = new WeakMap<ImageContent, { mimeType: string; data: string; id: string }>();

export function imageId(image: ImageContent): string {
  const cached = imageIds.get(image);
  if (cached?.mimeType === image.mimeType && cached.data === image.data) return cached.id;
  const id = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
  imageIds.set(image, { mimeType: image.mimeType, data: image.data, id });
  return id;
}

function imageBlocks(message: AgentMessage): (ImageContent | TextContent)[] | undefined {
  if (message.role === "user" || message.role === "toolResult") {
    return Array.isArray(message.content) ? message.content : undefined;
  }
  return undefined;
}

export function findImage(messages: readonly AgentMessage[], id: string): ImageContent | undefined {
  for (const message of messages) {
    for (const block of imageBlocks(message) ?? []) {
      if (block.type === "image" && imageId(block) === id) return block;
    }
  }
  return undefined;
}

export function supportsProjection(model: { api: string; baseUrl: string; compat?: unknown }, codexTransport?: "sse"): boolean {
  if (model.api === "anthropic-messages") {
    const compat = model.compat;
    const threads = typeof compat === "object" && compat !== null && "supportsMessageThreads" in compat
      ? compat.supportsMessageThreads : undefined;
    return !(typeof threads === "boolean" ? threads : model.baseUrl.includes("api.anthropic.com"));
  }
  return model.api === "openai-completions" || model.api === "openai-responses" || (model.api === "openai-codex-responses" && codexTransport === "sse");
}

export function projectImages(messages: AgentMessage[], recoverable: (id: string) => boolean) {
  let processedThrough = -1;
  // A successful response acknowledges its input images, including during tool loops.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "toolUse")) {
      processedThrough = i;
    }
  }
  let omittedImages = 0;
  let omittedBase64Bytes = 0;
  const result = messages.slice();
  const processedImages = new Set<string>();
  const includedImages = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    const content = message.content.map(block => {
      if (block.type !== "image") return block;
      const id = imageId(block);
      const processed = i < processedThrough;
      if (processed) processedImages.add(id);
      const recalled = message.role === "toolResult" && message.toolName === RECALL_TOOL;
      if (!processed && !includedImages.has(id) && (!processedImages.has(id) || recalled)) {
        includedImages.add(id);
        return block;
      }
      const text = includedImages.has(id)
        ? `[Image reference ${id}. Identical image is already included earlier in this request.]`
        : `[Image reference ${id}. Previously provided or available elsewhere in this request. Use ${RECALL_TOOL} with this ID if exact visual details are needed.]`;
      if (block.data.length <= text.length || !recoverable(id)) return block;
      omittedImages++;
      omittedBase64Bytes += block.data.length;
      return { type: "text" as const, text };
    });
    if (content.some((block, index) => block !== message.content[index])) {
      result[i] = { ...message, content };
    }
  }
  return { messages: result, omittedImages, omittedBase64Bytes };
}
