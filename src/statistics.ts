import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const STATS_ENTRY = "image-context-trimmer-statistics";
export type DisplayMode = "summary" | "off";
export interface TrimConfig { enabled: boolean; display: DisplayMode }
export const defaultConfig: TrimConfig = { enabled: true, display: "summary" };

export function readTrimConfig(path: string): TrimConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { ...defaultConfig };
    throw error;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Expected a configuration object.");
  const { enabled, display } = data as Partial<TrimConfig>;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
  if (display !== undefined && display !== "summary" && display !== "off") throw new Error("display must be summary or off.");
  return { enabled: enabled ?? defaultConfig.enabled, display: display ?? defaultConfig.display };
}

export interface ProjectionMetrics {
  imageBlocks: number;
  imageBase64Bytes: number;
  omittedImages: number;
  omittedBase64Bytes: number;
  referenceBytes: number;
}

export function measureProjection(messages: readonly AgentMessage[], projected?: { messages: readonly AgentMessage[]; omittedImages: number; omittedBase64Bytes: number }): ProjectionMetrics {
  const metrics = { imageBlocks: 0, imageBase64Bytes: 0, omittedImages: projected?.omittedImages ?? 0, omittedBase64Bytes: projected?.omittedBase64Bytes ?? 0, referenceBytes: 0 };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) continue;
    const after = projected?.messages[i];
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block.type !== "image") continue;
      metrics.imageBlocks++;
      metrics.imageBase64Bytes += block.data.length;
      if (after && (after.role === "user" || after.role === "toolResult") && Array.isArray(after.content)) {
        const replacement = after.content[j];
        if (replacement?.type === "text") metrics.referenceBytes += Buffer.byteLength(replacement.text);
      }
    }
  }
  return metrics;
}

export type BypassReason = "disabled" | "model has no image input" | "unsupported or incremental API" | "recall tool unavailable";

export interface TrimStatistics extends ProjectionMetrics {
  eligibleProjections: number;
  optimizedProjections: number;
  bypassedProjections: number;
  bypassReasons: Partial<Record<BypassReason, number>>;
  recallAttempts: number;
  successfulRecalls: number;
  reportedTokens: number;
  reportedResponses: number;
}

export function emptyStatistics(): TrimStatistics {
  return { imageBlocks: 0, imageBase64Bytes: 0, omittedImages: 0, omittedBase64Bytes: 0, referenceBytes: 0, eligibleProjections: 0, optimizedProjections: 0, bypassedProjections: 0, bypassReasons: {}, recallAttempts: 0, successfulRecalls: 0, reportedTokens: 0, reportedResponses: 0 };
}

export function recordProjection(stats: TrimStatistics, metrics: ProjectionMetrics, bypass?: BypassReason): void {
  stats.imageBlocks += metrics.imageBlocks;
  stats.imageBase64Bytes += metrics.imageBase64Bytes;
  stats.omittedImages += metrics.omittedImages;
  stats.omittedBase64Bytes += metrics.omittedBase64Bytes;
  stats.referenceBytes += metrics.referenceBytes;
  if (bypass) {
    stats.bypassedProjections++;
    stats.bypassReasons[bypass] = (stats.bypassReasons[bypass] ?? 0) + 1;
  } else {
    stats.eligibleProjections++;
    if (metrics.omittedImages > 0) stats.optimizedProjections++;
  }
}

export interface StatsEntryData {
  scope: "task" | "session";
  stats: TrimStatistics;
  config: TrimConfig;
  bypass?: BypassReason;
  aborted?: boolean;
}

const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} B`;

export const renderStatistics: EntryRenderer<StatsEntryData> = (entry, { expanded }, theme) => {
  const data = entry.data;
  if (!data?.stats) return undefined;
  const s = data.stats;
  const percent = s.imageBase64Bytes ? ` (${(100 * s.omittedBase64Bytes / s.imageBase64Bytes).toFixed(1)}%)` : "";
  const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
  const scope = data.scope === "session" ? "Session since load" : data.aborted ? "Task stopped" : "Task";
  box.addChild(new Text(`${theme.fg("accent", "Image Context Trimmer")} · ${scope}`, 0, 0));
  if (data.scope === "session") box.addChild(new Text(`Trimming: ${data.config.enabled ? "on" : "off"} · ${data.bypass ? "bypassed" : "eligible"} · Auto display: ${data.config.display}`, 0, 0));
  box.addChild(new Text(`Image blocks ${s.imageBlocks} → ${s.imageBlocks - s.omittedImages} · ${s.omittedImages} replaced · Base64 omitted ${formatBytes(s.omittedBase64Bytes)}${percent}`, 0, 0));
  if (s.recallAttempts > 0) box.addChild(new Text(`Image recalls ${s.successfulRecalls}/${s.recallAttempts} successful`, 0, 0));
  const reasons = Object.entries(s.bypassReasons).map(([reason, count]) => `${reason} (${count})`).join(", ");
  if (data.bypass || reasons) box.addChild(new Text(theme.fg("dim", `Bypass: ${data.bypass ?? reasons}`), 0, 0));
  else if (s.imageBlocks > 0 && s.omittedImages === 0) box.addChild(new Text(theme.fg("dim", "No image blocks replaced; existing images retained."), 0, 0));
  if (expanded) {
    box.addChild(new Text([
      `Base64 in image context: ${formatBytes(s.imageBase64Bytes)} → ${formatBytes(s.imageBase64Bytes - s.omittedBase64Bytes)}`,
      `Replacement text: ${formatBytes(s.referenceBytes)} · net content omitted: ${formatBytes(s.omittedBase64Bytes - s.referenceBytes)}`,
      `Projections: ${s.eligibleProjections} eligible · ${s.optimizedProjections} optimized · ${s.bypassedProjections} bypassed`,
      `Pi-reported total tokens: ${s.reportedResponses ? s.reportedTokens.toLocaleString("en-US") : "n/a"} (not tokens saved)`,
      ...(data.scope === "task" ? [`Trimming: ${data.config.enabled ? "on" : "off"} · Auto display: ${data.config.display}`] : []),
      "Context measurements, not network traffic or billing.",
    ].join("\n"), 0, 0));
  }
  return box;
};
