import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { chooseProjection, type CacheDecision, type WarmProjection } from "./cache-economics.ts";
import { thresholdDeferral } from "./compaction.ts";
import { findImage, indexSourceImages, projectImages, RECALL_TOOL, supportsProjection } from "./image-context.ts";
import { defaultConfig, emptyStatistics, measureProjection, readTrimConfig, recordProjection, renderStatistics, STATS_ENTRY, type BypassReason, type StatsEntryData, type TrimStatistics } from "./statistics.ts";

export default function imageContext(pi: ExtensionAPI, options: { codexTransport?: "sse"; configPath?: string } = {}): void {
  let config = { ...defaultConfig };
  let session = emptyStatistics();
  let task: TrimStatistics | undefined;
  let previous: WarmProjection | undefined;
  let pending: ReturnType<typeof chooseProjection>["snapshot"];
  let sent = false;
  let pendingDecision: CacheDecision | undefined;
  let cumulativeDeferredBytes = 0;
  let forceTrim = false;
  let cacheWriteSeen = false;
  let longCacheWriteSeen = false;
  const resetCache = () => {
    previous = undefined; pending = undefined; pendingDecision = undefined; sent = false;
    forceTrim = false; cacheWriteSeen = false; longCacheWriteSeen = false; cumulativeDeferredBytes = 0;
  };
  const createProjection = (messages: AgentMessage[], ctx: ExtensionContext) => {
    let lookup: ReturnType<typeof indexSourceImages> | undefined;
    const ids = new WeakMap<ImageContent, string | undefined>();
    const identify = (block: ImageContent) => {
      if (ids.has(block)) return ids.get(block);
      lookup ??= indexSourceImages(ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []));
      const id = lookup(block);
      ids.set(block, id);
      return id;
    };
    return { full: projectImages(messages, () => true, identify), identify };
  };

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
    resetCache();
    try {
      config = readTrimConfig(options.configPath ?? join(getAgentDir(), "image-context-trimmer.json"));
    } catch {
      config = { ...defaultConfig };
      ctx.ui.notify("Invalid image-context-trimmer.json; using defaults.", "warning");
    }
  });
  pi.on("agent_start", () => { task ??= emptyStatistics(); });
  pi.on("before_provider_request", () => {
    // Count an issued logical projection once, not context previews, retries, or cache-warming replays.
    if (!task || !pending || sent) return;
    sent = true;
    const bytes = pendingDecision?.deferredBase64Bytes ?? 0;
    cumulativeDeferredBytes = bytes > 0 ? cumulativeDeferredBytes + bytes : 0;
    const decision = pendingDecision;
    if (decision) forStats(stats => {
      stats.cacheEvaluations++;
      if (bytes > 0) stats.cacheDeferrals++;
      stats.deferredBase64Bytes += bytes;
      if (decision.reason !== "deferred" && bytes > 0) stats.selectiveProjections++;
      if (decision.reason === "cumulative bandwidth limit") stats.cumulativeBandwidthForces++;
      stats.lastCacheDecision = decision;
    });
  });
  pi.on("model_select", resetCache);
  pi.on("session_tree", resetCache);
  pi.on("session_compact", event => {
    resetCache();
    forStats(stats => {
      stats.nativeCompactions++;
      const tokens = event.compactionEntry.usage?.totalTokens;
      if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
        stats.nativeCompactionTokens += tokens;
        stats.nativeCompactionUsageRecords++;
      }
    });
  });
  pi.on("turn_end", event => {
    if (event.message.role !== "assistant") return;
    const { usage, stopReason } = event.message;
    if (stopReason === "stop" || stopReason === "toolUse") {
      cacheWriteSeen ||= usage.cacheWrite > 0;
      longCacheWriteSeen ||= (usage.cacheWrite1h ?? 0) > 0;
    }
    if (sent && pending && (stopReason === "stop" || stopReason === "toolUse") && usage.totalTokens > 0) {
      previous = { ...pending, usage, at: Date.now(), cacheWriteSeen, longCacheWriteSeen };
    } else previous = undefined;
    pending = undefined;
    pendingDecision = undefined;
    sent = false;
    const tokens = usage.totalTokens;
    if (!Number.isFinite(tokens) || tokens < 0) return;
    forStats(stats => {
      stats.reportedTokens += tokens; stats.reportedResponses++;
      stats.inputTokens += usage.input; stats.cacheReadTokens += usage.cacheRead;
      stats.cacheWriteTokens += usage.cacheWrite; stats.outputTokens += usage.output;
    });
  });
  pi.on("agent_settled", event => {
    const settled = task;
    task = undefined;
    if (config.display === "summary" && settled && (settled.imageBlocks > 0 || settled.recallAttempts > 0 || settled.deferredCompactions > 0)) {
      appendStats("task", settled, { aborted: event.aborted });
    }
  });

  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall context image",
    description: "Read an original image from the current conversation by its image-reference ID. Completed-task images may become references. Use this tool only when exact visual details are needed and not already visible. Distinct images stay available throughout the current user task.",
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

  pi.on("session_before_compact", (event, ctx) => {
    if (!config.compactionGuard || event.reason !== "threshold" || event.willRetry || whyBypassed(ctx) || !ctx.model) return;
    const projection = ctx.sessionManager.buildSessionProjection();
    const raw = projection.messages;
    const { full } = createProjection(raw, ctx);
    if (!full.omittedImages) return;
    const assessment = thresholdDeferral(raw, full.messages, event.preparation.tokensBefore, ctx.model.contextWindow, event.preparation.settings.reserveTokens, { projection, branchEntries: event.branchEntries });
    if (!assessment.defer) return;
    forceTrim = true;
    forStats(stats => { stats.deferredCompactions++; });
    return { cancel: true };
  });

  pi.on("context_with_system", (event, ctx) => {
    pending = undefined;
    pendingDecision = undefined;
    sent = false;
    const bypass = whyBypassed(ctx);
    if (bypass || !ctx.model) {
      resetCache();
      const metrics = measureProjection(event.messages);
      forStats(stats => recordProjection(stats, metrics, bypass));
      return;
    }
    const { full, identify } = createProjection(event.messages, ctx);
    const usage = full.omittedImages && config.cacheAware && previous ? ctx.getContextUsage() : undefined;
    const pressure = forceTrim || (usage?.tokens != null && usage.contextWindow > 0 && usage.tokens >= 0.85 * usage.contextWindow);
    const { projection, snapshot, decision } = chooseProjection(event.messages, full, identify, previous, ctx.model, config, pressure, Date.now(), cumulativeDeferredBytes);
    forceTrim = false;
    pending = snapshot;
    pendingDecision = decision;
    const metrics = measureProjection(event.messages, projection);
    forStats(stats => recordProjection(stats, metrics));
    if (projection.omittedImages) return { messages: projection.messages };
  });

  pi.registerCommand("image-context-trimmer", {
    description: "Image history optimization: status, on, off, display summary/off",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        config.enabled = action === "on";
        resetCache();
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
