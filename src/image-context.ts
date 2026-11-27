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

/** Index original session blocks so Pi's request-time clones reuse their cached hashes. */
export function indexSourceImages(messages: readonly AgentMessage[]) {
  const images = new Map<string, Map<string, ImageContent>>();
  for (const message of messages) {
    for (const block of imageBlocks(message) ?? []) {
      if (block.type !== "image") continue;
      let byData = images.get(block.mimeType);
      if (!byData) images.set(block.mimeType, byData = new Map());
      if (!byData.has(block.data)) byData.set(block.data, block);
    }
  }
  return (image: ImageContent): string | undefined => {
    const source = images.get(image.mimeType)?.get(image.data);
    return source ? imageId(source) : undefined;
  };
}

export function projectImages(messages: AgentMessage[], recoverable: (id: string) => boolean, identify: (image: ImageContent) => string | undefined = imageId, shouldReplace: (messageIndex: number, blockIndex: number, active: boolean) => boolean = () => true) {
  let completedThrough = -1;
  let pendingStop = -1;
  // Tool calls do not prove the model has finished using the visual evidence.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") pendingStop = message.stopReason === "stop" ? i : -1;
    else if (message.role === "user") {
      if (pendingStop !== -1) completedThrough = pendingStop;
      pendingStop = -1;
    }
  }
  let omittedImages = 0;
  let omittedBase64Bytes = 0;
  const result = messages.slice();
  const includedImages = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    const content = message.content.map((block, j) => {
      if (block.type !== "image") return block;
      const id = identify(block);
      if (!id) return block;
      const active = i > completedThrough;
      if (active && !includedImages.has(id)) {
        includedImages.add(id);
        return block;
      }
      // The same reference text remains valid when its first visible copy becomes historical.
      const text = `[Image reference ${id}. Use ${RECALL_TOOL} only if not visible.]`;
      if (block.data.length <= text.length || !recoverable(id) || !shouldReplace(i, j, active)) return block;
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
