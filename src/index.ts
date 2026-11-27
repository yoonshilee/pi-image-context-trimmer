import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findImage, imageId, projectImages, RECALL_TOOL, supportsProjection } from "./image-context.ts";

export default function imageContext(pi: ExtensionAPI, options: { codexTransport?: "sse" } = {}): void {
  let enabled = true;
  let requests = 0;
  let omittedImages = 0;
  let omittedBytes = 0;

  pi.on("session_start", () => {
    requests = omittedImages = omittedBytes = 0;
    enabled = true;
  });

  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall context image",
    description: "Read an original image from the current conversation by its image-reference ID. Call this when an image reference lacks the visual detail needed for your answer.",
    parameters: Type.Object({ id: Type.String({ description: "The exact 64-character image reference ID.", pattern: "^[a-f0-9]{64}$" }) }),
    async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
      const messages = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const image = findImage(messages, id);
      if (!image) throw new Error("Image reference is unavailable in the current session branch.");
      return { content: [{ type: "text", text: `Original image ${id}:` }, image], details: {} };
    },
  });

  pi.on("context", (event, ctx) => {
    if (!enabled || !ctx.model?.input.includes("image") || !supportsProjection(ctx.model.api, options.codexTransport) || !pi.getActiveTools().includes(RECALL_TOOL)) return;
    // Build the source index only when there is an image to replace.
    let available: Set<string> | undefined;
    const projected = projectImages(event.messages, id => {
      if (!available) {
        available = new Set<string>();
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "message") continue;
          const message = entry.message;
          if ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)) {
            for (const block of message.content) if (block.type === "image") available.add(imageId(block));
          }
        }
      }
      return available.has(id);
    });
    requests++;
    omittedImages += projected.omittedImages;
    omittedBytes += projected.omittedBase64Bytes;
    if (projected.omittedImages) return { messages: projected.messages };
  });

  pi.registerCommand("image-context-trimmer", {
    description: "Image history optimization: status, on, off",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") enabled = action === "on";
      else if (action !== "status") { ctx.ui.notify("Usage: /image-context-trimmer [status|on|off]", "warning"); return; }
      const supported = !!ctx.model?.input.includes("image") && supportsProjection(ctx.model.api, options.codexTransport) && pi.getActiveTools().includes(RECALL_TOOL);
      ctx.ui.notify(`Image context trimmer: ${enabled ? "on" : "off"}; API ${supported ? "supported" : "bypassed"}; ${requests} eligible requests, ${omittedImages} image blocks replaced, ${(omittedBytes / 1024 / 1024).toFixed(2)} MiB of Base64 omitted.`, "info");
    },
  });
}
