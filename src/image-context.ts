import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const RECALL_TOOL = "recall_context_image";

export function imageId(image: ImageContent): string {
  return createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
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

export function supportsProjection(api: string, codexTransport?: "sse"): boolean {
  return api === "openai-completions" || api === "openai-responses" || (api === "openai-codex-responses" && codexTransport === "sse");
}

export function projectImages(messages: AgentMessage[], recoverable: (id: string) => boolean) {
  let seenResponse = false;
  let omittedImages = 0;
  let omittedBase64Bytes = 0;
  const result = messages.slice();
  const fresh = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "toolUse")) {
      seenResponse = true;
    }
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    const content = message.content.map(block => {
      if (block.type !== "image") return block;
      const id = imageId(block);
      if (!seenResponse && !fresh.has(id)) {
        fresh.add(id);
        return block;
      }
      const text = `[Image reference ${id}. Previously provided or available elsewhere in this request. Use ${RECALL_TOOL} with this ID if exact visual details are needed.]`;
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
