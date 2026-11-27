import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findImage, imageId, projectImages, RECALL_TOOL, supportsProjection } from "./image-context.ts";
import { defaultConfig, emptyStatistics, measureProjection, readTrimConfig, recordProjection, renderStatistics, STATS_ENTRY, type BypassReason, type StatsEntryData, type TrimStatistics } from "./statistics.ts";

export default function imageContext(pi: ExtensionAPI, options: { codexTransport?: "sse"; configPath?: string } = {}): void {
  let config = { ...defaultConfig };
  let session = emptyStatistics();
  let task: TrimStatistics | undefined;

  const forStats = (update: (stats: TrimStatistics) => void) => {
    update(session);
    if (task) update(task);
  };
  const whyBypassed = (ctx: ExtensionContext): BypassReason | undefined => {
    if (!config.enabled) return "disabled";
    if (!ctx.model?.input.includes("image")) return "model has no image input";
    if (!supportsProjection(ctx.model, options.codexTransport)) return "unsupported or incremental API";
    if (!pi.getActiveTools().includes(RECALL_TOOL)) return "recall tool unavailable";
  };
  const appendStats = (scope: StatsEntryData["scope"], stats: TrimStatistics, details: Pick<StatsEntryData, "bypass" | "aborted"> = {}) => {
    pi.appendEntry<StatsEntryData>(STATS_ENTRY, { scope, stats: structuredClone(stats), config: { ...config }, ...details });
  };

  pi.registerEntryRenderer(STATS_ENTRY, renderStatistics);
  pi.on("session_start", (_event, ctx) => {
    session = emptyStatistics();
    task = undefined;
    try {
      config = readTrimConfig(options.configPath ?? join(getAgentDir(), "image-context-trimmer.json"));
    } catch {
      config = { ...defaultConfig };
      ctx.ui.notify("Invalid image-context-trimmer.json; using defaults.", "warning");
    }
  });
  pi.on("agent_start", () => { task ??= emptyStatistics(); });
  pi.on("turn_end", event => {
    if (event.message.role !== "assistant") return;
    const tokens = event.message.usage.totalTokens;
    if (!Number.isFinite(tokens) || tokens < 0) return;
    forStats(stats => { stats.reportedTokens += tokens; stats.reportedResponses++; });
  });
  pi.on("agent_settled", event => {
    const settled = task;
    task = undefined;
    if (config.display === "summary" && settled && (settled.imageBlocks > 0 || settled.recallAttempts > 0)) {
      appendStats("task", settled, { aborted: event.aborted });
    }
  });

  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall context image",
    description: "Read an original image from the current conversation by its image-reference ID. Images become references after a successful model response, including within a tool loop. Call this when a reference lacks the visual detail needed for your answer; recall multiple images in the same tool batch to compare them together.",
    parameters: Type.Object({ id: Type.String({ description: "The exact 64-character image reference ID.", pattern: "^[a-f0-9]{64}$" }) }),
    async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
      forStats(stats => { stats.recallAttempts++; });
      const messages = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const image = findImage(messages, id);
      if (!image) throw new Error("Image reference is unavailable in the current session branch.");
      forStats(stats => { stats.successfulRecalls++; });
      return { content: [{ type: "text", text: `Original image ${id}:` }, image], details: {} };
    },
  });

  pi.on("context_with_system", (event, ctx) => {
    const bypass = whyBypassed(ctx);
    if (bypass) {
      const metrics = measureProjection(event.messages);
      forStats(stats => recordProjection(stats, metrics, bypass));
      return;
    }
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
    const metrics = measureProjection(event.messages, projected);
    forStats(stats => recordProjection(stats, metrics));
    if (projected.omittedImages) return { messages: projected.messages };
  });

  pi.registerCommand("image-context-trimmer", {
    description: "Image history optimization: status, on, off, display summary/off",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        config.enabled = action === "on";
        ctx.ui.notify(`Image context trimmer: ${action}.`, "info");
      } else if (action === "display summary" || action === "display on" || action === "display off") {
        config.display = action === "display off" ? "off" : "summary";
        ctx.ui.notify(`Image context trimmer automatic cards: ${config.display}.`, "info");
      } else if (action === "status") {
        appendStats("session", session, { bypass: whyBypassed(ctx) });
      } else {
        ctx.ui.notify("Usage: /image-context-trimmer [status|on|off|display summary|display off]", "warning");
      }
    },
  });
}
