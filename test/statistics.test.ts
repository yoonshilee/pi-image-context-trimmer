import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import imageContext from "../src/index.ts";
import { imageId, RECALL_TOOL } from "../src/image-context.ts";
import { defaultConfig, readTrimConfig, renderStatistics, STATS_ENTRY, type StatsEntryData, type TrimConfig } from "../src/statistics.ts";

const fixture = await readFile(new URL("./fixture.png", import.meta.url));
const image: ImageContent = { type: "image", mimeType: "image/png", data: fixture.toString("base64") };
const imageCount = (body: string) => body.split(image.data).length - 1;

const tailImage: ImageContent = (() => {
  // Insert a valid PNG text chunk before IEND for a distinct, larger synthetic payload.
  const type = Buffer.from("tEXt");
  const data = Buffer.alloc(128 * 1024 - fixture.length - 12, "x");
  data.write("Fixture\0Tail");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return { type: "image", mimeType: "image/png", data: Buffer.concat([fixture.subarray(0, -12), chunk, fixture.subarray(-12)]).toString("base64") };
})();
const tailImageCount = (body: string) => body.split(tailImage.data).length - 1;

async function setup(t: TestContext, config?: Partial<TrimConfig>, recall = false, options: {
  warm?: boolean; tailImage?: boolean; warmAgainAt?: number; seed?: Parameters<SessionManager["appendMessage"]>[0][]; seedEdit?: { index: number; replacement: Parameters<SessionManager["appendContextEdit"]>[1] }; contextWindow?: number; reserveTokens?: number;
} = {}) {
  const bodies: string[] = [];
  let previousPrefix: { key: string; tokens: number }[] = [];
  const simulatedUsage: { input: number; cached: number }[] = [];
  const simulateCache = (body: string) => {
    const payload = JSON.parse(body);
    const messages = [payload.tools ?? [], ...payload.messages].map(message => {
      const key = JSON.stringify(message);
      let images = 0;
      const text = key.replace(/data:image\/[^;"\s]+;base64,[A-Za-z0-9+/=]+/g, () => { images++; return "[image]"; });
      return { key, tokens: Math.ceil(text.length / 4) + images * 1200 };
    });
    let shared = 0;
    while (shared < previousPrefix.length && shared < messages.length && previousPrefix[shared].key === messages[shared].key) shared++;
    const promptTokens = messages.reduce((sum, message) => sum + message.tokens, 0);
    const cached = messages.slice(0, shared).reduce((sum, message) => sum + message.tokens, 0);
    previousPrefix = messages;
    simulatedUsage.push({ input: promptTokens - cached, cached });
    return { prompt_tokens: promptTokens, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: 2, total_tokens: promptTokens + 2 };
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    const shouldRecall = recall && bodies.length === 2;
    const longTool = options.warm && (bodies.length === 1 || bodies.length === options.warmAgainAt);
    const tailTool = options.tailImage && bodies.length === 2;
    const delta = longTool ? { role: "assistant", tool_calls: [{ index: 0, id: bodies.length === 1 ? "long-result" : `long-result-${bodies.length}`, type: "function", function: { name: "long_result", arguments: "{}" } }] } :
      tailTool ? { role: "assistant", tool_calls: [{ index: 0, id: "tail-result", type: "function", function: { name: "tail_result", arguments: "{}" } }] } :
      shouldRecall ? { role: "assistant", tool_calls: [{ index: 0, id: "stats-recall", type: "function", function: { name: RECALL_TOOL, arguments: JSON.stringify({ id: imageId(image) }) } }] } : { role: "assistant", content: "Done." };
    const frame = (choices: object[], usage?: object) => `data: ${JSON.stringify({ id: `stats-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices, usage })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame([{ index: 0, delta, finish_reason: null }]) + frame([{ index: 0, delta: {}, finish_reason: shouldRecall || longTool || tailTool ? "tool_calls" : "stop" }]) + frame([], options.warm ? simulateCache(bodies.at(-1)!) : { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }) + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-stats-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(agentDir, "image-context-trimmer.json");
  if (config) await writeFile(configPath, JSON.stringify(config));
  const model: Model<"openai-completions"> = {
    id: "fixture", name: "Fixture", provider: "image-stats-test", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", input: ["text", "image"], reasoning: false,
    cost: options.warm ? { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: options.contextWindow ?? 128000, maxTokens: 4096,
  };
  const settings = SettingsManager.inMemory({ compaction: options.reserveTokens === undefined ? { enabled: false } : { enabled: true, reserveTokens: options.reserveTokens, keepRecentTokens: 100 }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture", models: [model] }),
      ...(options.warm ? [(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => pi.registerTool({ name: "long_result", label: "Long result", description: "Return a text result.", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "warm cache evidence ".repeat(2000) }], details: {} }; } })] : []),
      ...(options.tailImage ? [(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => pi.registerTool({ name: "tail_result", label: "Tail image", description: "Return a second image.", parameters: Type.Object({}), async execute() { return { content: [tailImage], details: {} }; } })] : []), pi => imageContext(pi, { configPath })] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert(loader.getExtensions().extensions.some(ext => ext.entryRenderers?.has(STATS_ENTRY)));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
  const seedIds = (options.seed ?? []).map(message => manager.appendMessage(message));
  if (options.seedEdit) manager.appendContextEdit(seedIds[options.seedEdit.index], options.seedEdit.replacement);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: "builtin" });
  t.after(() => session.dispose());
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  t.after(() => assert.deepEqual(errors, []));
  const entries = () => session.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === STATS_ENTRY ? [{ ...entry, data: entry.data as StatsEntryData }] : []);
  return { session, bodies, entries, configPath, simulatedUsage };
}

test("settled tasks render durable cards, report recalls and token usage without entering model context", async t => {
  const { session, bodies, entries } = await setup(t, undefined, true);
  await session.prompt("Read the image", { images: [image] });
  assert.equal(entries().length, 1);
  const first = entries()[0].data;
  assert.equal(first.scope, "task");
  assert.equal(first.stats.imageBlocks, 1);
  assert.equal(first.stats.omittedImages, 0);
  await session.prompt("Revisit the image");
  assert.equal(entries().length, 2, "one card per settled task, not per model request");
  const stats = entries()[1].data.stats;
  assert.deepEqual(bodies.map(imageCount), [1, 0, 1]);
  assert.equal(stats.eligibleProjections, 2);
  assert.equal(stats.imageBlocks, 3);
  assert.equal(stats.omittedImages, 2);
  assert.equal(stats.omittedBase64Bytes, 2 * image.data.length);
  assert(stats.referenceBytes > 0 && stats.referenceBytes < stats.omittedBase64Bytes);
  assert.equal(stats.recallAttempts, 1);
  assert.equal(stats.successfulRecalls, 1);
  assert.equal(stats.reportedTokens, 20);
  assert.equal(entries()[0].data.stats.omittedImages, 0, "earlier card is a snapshot");
  await session.prompt("/image-context-trimmer status");
  assert.equal(bodies.length, 3, "manual status does not call the model");
  const summary = entries().at(-1)!.data;
  assert.equal(summary.scope, "session");
  assert.equal(summary.stats.reportedTokens, 30);
  assert.equal(summary.stats.omittedImages, 2);
  await session.prompt("Finish");
  const sessionFile = session.sessionManager.getSessionFile();
  assert(sessionFile);
  const restored = SessionManager.open(sessionFile);
  assert.equal(restored.getBranch().filter(entry => entry.type === "custom" && entry.customType === STATS_ENTRY).length, entries().length, "cards survive reopening a file-backed session");
  assert(bodies.every(body => !body.includes(STATS_ENTRY) && !body.includes("Pi-reported total tokens") && !body.includes("omittedBase64Bytes")), "custom entries must not enter LLM requests");
  // Render the real registered card in compact and expanded form with a colorless theme.
  const theme = { bg: (_name: string, value: string) => value, fg: (_name: string, value: string) => value } as Theme;
  const opts = { expanded: false, keyHint: () => "", keyText: () => "" };
  const card = entries()[1];
  const compact = renderStatistics(card, opts, theme)!.render(100).join("\n");
  const expanded = renderStatistics(card, { ...opts, expanded: true }, theme)!.render(100).join("\n");
  assert(compact.includes("2 replaced"));
  assert(!compact.includes("Pi-reported"));
  assert(expanded.includes("Pi-reported total tokens: 20"));
  // Previously persisted cards lack the new counters and cumulative budget.
  const legacy = JSON.parse(JSON.stringify(card));
  delete legacy.data.stats.deferredBase64Bytes;
  delete legacy.data.stats.selectiveProjections;
  delete legacy.data.stats.cumulativeBandwidthForces;
  delete legacy.data.config.maxCumulativeDeferredBase64Bytes;
  const restoredCard = renderStatistics(legacy, { ...opts, expanded: true }, theme)!.render(100).join("\n");
  assert(restoredCard.includes("Pi-reported total tokens: 20"));
  assert(!restoredCard.includes("undefined") && !restoredCard.includes("NaN"));
});

test("configuration and display commands control cards independently of trimming", async t => {
  const { session, bodies, entries, configPath } = await setup(t, { enabled: true, display: "off" });
  await session.prompt("Inspect", { images: [image] });
  await session.prompt("Continue");
  assert.equal(entries().length, 0);
  assert.deepEqual(bodies.map(imageCount), [1, 0]);
  await session.prompt("/image-context-trimmer status");
  assert.equal(entries().length, 1);
  assert.equal(entries()[0].data.stats.omittedImages, 1);
  await session.prompt("/image-context-trimmer display summary");
  await session.prompt("One more question");
  assert.equal(entries().length, 2);
  assert.equal(entries()[1].data.scope, "task");
  await session.prompt("/image-context-trimmer display off");
  await session.prompt("Finish");
  assert.equal(entries().length, 2);
  assert.deepEqual(bodies.map(imageCount), [1, 0, 0, 0]);
  assert.deepEqual(readTrimConfig(configPath), { ...defaultConfig, display: "off" }, "slash commands change only current session");
});

test("disabled trimming emits an explanatory card only when images are relevant", async t => {
  const { session, bodies, entries } = await setup(t, { enabled: false, display: "summary" });
  await session.prompt("Text only");
  assert.equal(entries().length, 0);
  await session.prompt("Inspect", { images: [image] });
  await session.prompt("Follow up");
  assert.equal(entries().length, 2);
  assert.deepEqual(bodies.map(imageCount), [0, 1, 1]);
  assert.equal(entries()[1].data.stats.bypassReasons.disabled, 1);
  assert.equal(entries()[1].data.stats.omittedImages, 0);
  await session.prompt("/image-context-trimmer on");
  await session.prompt("Continue");
  assert.equal(imageCount(bodies.at(-1)!), 0);
  assert.equal(entries()[2].data.stats.omittedImages, 1);
});


test("configuration validates display mode and enable flag", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-stats-config-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "image-context-trimmer.json");
  assert.deepEqual(readTrimConfig(file), defaultConfig);
  await writeFile(file, '{"enabled":false}');
  assert.deepEqual(readTrimConfig(file), { ...defaultConfig, enabled: false });
  await writeFile(file, '{"enabled":"false"}');
  assert.throws(() => readTrimConfig(file), /enabled must be a boolean/);
  await writeFile(file, '{"display":"live"}');
  assert.throws(() => readTrimConfig(file), /display must be summary or off/);
  await writeFile(file, '{"cacheHorizonRequests":0}');
  assert.throws(() => readTrimConfig(file), /positive integer/);
  await writeFile(file, '{"maxDeferredBase64Bytes":-1}');
  assert.throws(() => readTrimConfig(file), /non-negative integer/);
  for (const value of [-1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    await writeFile(file, JSON.stringify({ maxCumulativeDeferredBase64Bytes: value }));
    assert.throws(() => readTrimConfig(file), /maxCumulativeDeferredBase64Bytes must be a non-negative integer/);
  }
  await writeFile(file, '{"cacheAware":false,"compactionGuard":false,"cacheHorizonRequests":8,"maxDeferredBase64Bytes":0,"maxCumulativeDeferredBase64Bytes":0}');
  assert.deepEqual(readTrimConfig(file), { ...defaultConfig, cacheAware: false, compactionGuard: false, cacheHorizonRequests: 8, maxDeferredBase64Bytes: 0, maxCumulativeDeferredBase64Bytes: 0 });
});

test("a new attachment of a historical image remains visible without an explicit recall", async t => {
  const { session, bodies, entries } = await setup(t);
  await session.prompt("First inspection", { images: [image] });
  await session.prompt("Inspect the same original again", { images: [image] });
  assert.deepEqual(bodies.map(imageCount), [1, 1]);
  assert.equal(entries().at(-1)!.data.stats.imageBlocks, 2);
  assert.equal(entries().at(-1)!.data.stats.omittedImages, 1);
  assert.equal(entries().at(-1)!.data.stats.recallAttempts, 0);
  await session.prompt("Continue without images");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 0]);
});


test("warm-cache deferral preserves a small historical image in the actual SDK request and reports economics", async t => {
  const { session, bodies, entries } = await setup(t, undefined, false, { warm: true });
  await session.prompt("Inspect this image and collect the long result", { images: [image] });
  assert.equal(bodies.length, 2);
  await session.prompt("Continue with the text result");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 1]);
  const stats = entries().at(-1)!.data.stats;
  assert.equal(stats.cacheDeferrals, 1);
  assert.equal(stats.deferredBase64Bytes, image.data.length);
  assert.equal(stats.lastCacheDecision?.reason, "deferred");
  assert(stats.lastCacheDecision!.estimatedRewriteCost! > stats.lastCacheDecision!.estimatedReadSavings!);
  assert(stats.cacheReadTokens > 0);
  const theme = { bg: (_name: string, value: string) => value, fg: (_name: string, value: string) => value } as Theme;
  const rendered = renderStatistics(entries().at(-1)!, { expanded: true, keyHint: () => "", keyText: () => "" }, theme)!.render(110).join("\n");
  assert(rendered.includes("Latest cache decision: deferred"));
  assert(rendered.includes("Estimated rewrite cost:"));
  assert(rendered.includes("break-even:"));
  assert(rendered.includes("Reported cache-read ratio:"));
  assert(rendered.includes("Cache-deferred Base64:"));
  assert(rendered.includes("Cumulative deferred-byte budget:"));
});

test("bandwidth limit forces a trim despite a warm cache", async t => {
  const { session, bodies, entries } = await setup(t, { maxDeferredBase64Bytes: 0 }, false, { warm: true });
  await session.prompt("Inspect and collect the result", { images: [image] });
  await session.prompt("Continue");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 0]);
  assert.equal(entries().at(-1)!.data.stats.lastCacheDecision?.reason, "bandwidth limit");
});

test("warm cache selectively trims a late historical image without invalidating the expensive early prefix", async t => {
  const retained = await setup(t, { enabled: false }, false, { warm: true, tailImage: true });
  const immediate = await setup(t, { cacheAware: false }, false, { warm: true, tailImage: true });
  const selective = await setup(t, undefined, false, { warm: true, tailImage: true });
  for (const trial of [retained, immediate, selective]) {
    await trial.session.prompt("Inspect this image and collect the long result and second image", { images: [image] });
  }
  const { bodies, entries } = selective;
  assert.deepEqual(bodies.map(imageCount), [1, 1, 1]);
  assert.deepEqual(bodies.map(tailImageCount), [0, 0, 1]);
  for (const trial of [retained, immediate, selective]) await trial.session.prompt("Continue with the text result");
  assert.equal(imageCount(bodies.at(-1)!), 1, "early image retained for the expensive cached suffix");
  assert.equal(tailImageCount(bodies.at(-1)!), 0, "late image was economical to replace");
  const stats = entries().at(-1)!.data.stats;
  assert.equal(stats.lastCacheDecision?.reason, "selective");
  assert.equal(stats.selectiveProjections, 1);
  assert.equal(stats.cacheDeferrals, 1);
  assert.equal(stats.deferredBase64Bytes, image.data.length);
  assert.equal(stats.omittedBase64Bytes, tailImage.data.length);

  for (const trial of [retained, immediate, selective]) {
    for (let i = 0; i < 3; i++) await trial.session.prompt(`Text follow-up ${i}`);
    assert.equal(trial.bodies.length, 7);
  }
  assert.deepEqual(retained.bodies.map(tailImageCount), [0, 0, 1, 1, 1, 1, 1]);
  assert.deepEqual(immediate.bodies.map(imageCount), [1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(selective.bodies.map(imageCount), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(selective.bodies.map(tailImageCount), [0, 0, 1, 0, 0, 0, 0]);
  const cost = (trial: typeof selective) => trial.simulatedUsage.reduce((sum, usage) => sum + (2 * usage.input + 0.1 * usage.cached) / 1e6, 0);
  const bytes = (trial: typeof selective) => trial.bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
  assert(cost(selective) < cost(immediate));
  assert(bytes(selective) < bytes(retained));
  console.log(`Selective synthetic prefix-cache scenario: retained $${cost(retained).toFixed(6)} / ${bytes(retained)} B; immediate $${cost(immediate).toFixed(6)} / ${bytes(immediate)} B; selective $${cost(selective).toFixed(6)} / ${bytes(selective)} B (7 requests each, simulated input/cache cost, not billing).`);
});

test("long text preceding an image in the same user message remains identical when the image is trimmed", async t => {
  const { session, bodies, entries } = await setup(t, undefined, false, { warm: true });
  await session.prompt("Warm the text context");
  const text = "This user content precedes its attachment. ".repeat(700);
  await session.prompt(text, { images: [image] });
  await session.prompt("Continue");
  assert.deepEqual(bodies.map(imageCount), [0, 0, 1, 0]);
  const attachedUser = JSON.parse(bodies[2]).messages.find((message: { content: unknown }) => JSON.stringify(message.content).includes(image.data));
  const trimmedUser = JSON.parse(bodies[3]).messages.find((message: { content: unknown }) => JSON.stringify(message.content).includes(imageId(image)));
  assert.deepEqual(attachedUser.content[0], trimmedUser.content[0], "the actual serialized text block before the image is unchanged");
  assert.equal(entries().at(-1)!.data.stats.lastCacheDecision?.reason, "economic");
});

test("cumulative bandwidth budget counts issued deferred projections, forces a trim, and resets for a new deferral", async t => {
  const limit = image.data.length * 2 + 1;
  const { session, bodies, entries } = await setup(t, { maxCumulativeDeferredBase64Bytes: limit }, false, { warm: true, warmAgainAt: 6 });
  await session.prompt("Inspect and collect the result", { images: [image] });
  await session.prompt("Text-only follow-up one");
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, image.data.length);
  const preview = await session.agent.transformContext?.(session.messages);
  assert(preview);
  assert.equal(bodies.length, 3, "a projection preview does not send a provider request");
  await session.prompt("/image-context-trimmer status");
  assert.equal(bodies.length, 3, "status must not consume the bandwidth budget");
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, image.data.length);
  await session.prompt("Text-only follow-up two");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 1, 1]);
  await session.prompt("Text-only follow-up three");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 1, 1, 0]);
  assert.equal(entries().at(-1)!.data.stats.lastCacheDecision?.reason, "cumulative bandwidth limit");
  assert.equal(entries().at(-1)!.data.stats.cumulativeBandwidthForces, 1);
  await session.prompt("/image-context-trimmer status");
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, 2 * image.data.length);
  assert.equal(entries().at(-1)!.data.stats.cumulativeBandwidthForces, 1);
  await session.prompt("Inspect the original and collect a new long result", { images: [image] });
  await session.prompt("Follow up on the new result");
  assert.equal(imageCount(bodies.at(-1)!), 1, "a new deferral after the prior force receives a fresh budget");
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, image.data.length);
  await session.prompt("/image-context-trimmer status");
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, 3 * image.data.length, "session statistics remain cumulative even when the budget resets");
});

test("zero cumulative budget immediately trims a warm-cache historical image", async t => {
  const { session, bodies, entries } = await setup(t, { maxCumulativeDeferredBase64Bytes: 0 }, false, { warm: true });
  await session.prompt("Inspect and collect the result", { images: [image] });
  await session.prompt("Continue");
  assert.deepEqual(bodies.map(imageCount), [1, 1, 0]);
  assert.equal(entries().at(-1)!.data.stats.cumulativeBandwidthForces, 1);
  assert.equal(entries().at(-1)!.data.stats.deferredBase64Bytes, 0);
});

test("a reattached warm historical image remains visible exactly once in the active request", async t => {
  const { session, bodies, entries } = await setup(t, undefined, false, { warm: true });
  await session.prompt("Inspect and collect the result", { images: [image] });
  await session.prompt("Continue without a new image");
  assert.equal(imageCount(bodies.at(-1)!), 1, "historical image was retained by the cache policy");
  await session.prompt("Inspect the original again", { images: [image] });
  assert.equal(imageCount(bodies.at(-1)!), 1, "only the active attachment remains a raw image");
  const payload = JSON.parse(bodies.at(-1)!);
  const latestUser = payload.messages.findLast((message: { role: string }) => message.role === "user");
  assert(JSON.stringify(latestUser).includes(image.data));
  const stats = entries().at(-1)!.data.stats;
  assert.equal(stats.omittedImages, 1);
  assert.equal(stats.recallAttempts, 0);
});

test("Pi threshold compaction is deferred when historical image trimming restores headroom; manual compaction remains available", async t => {
  const seed = Array.from({ length: 4 }, (_, i) => [
    { role: "user", timestamp: i * 2 + 1, content: [{ ...image }] },
    { ...fauxAssistantMessage("Done."), timestamp: i * 2 + 2, stopReason: "stop" },
  ]).flat() as Parameters<SessionManager["appendMessage"]>[0][];
  const withoutGuard = await setup(t, { compactionGuard: false }, false, { seed, contextWindow: 2400, reserveTokens: 500 });
  await withoutGuard.session.prompt("Continue without images");
  assert.equal(withoutGuard.bodies.length, 2, "native compaction makes one summary request and one normal request");
  assert(withoutGuard.session.sessionManager.getBranch().some(entry => entry.type === "compaction"));
  const { session, bodies, entries } = await setup(t, undefined, false, { seed, contextWindow: 2400, reserveTokens: 500 });
  await session.prompt("Continue without images");
  assert.equal(bodies.length, 1, "no extra summary provider request");
  assert.equal(imageCount(bodies[0]), 0);
  assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length, 0);
  await session.prompt("/image-context-trimmer status");
  assert(entries().at(-1)!.data.stats.deferredCompactions >= 1);
  await session.compact();
  assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length, 1);
  await session.prompt("/image-context-trimmer status");
  assert.equal(entries().at(-1)!.data.stats.nativeCompactions, 1);
  assert.equal(entries().at(-1)!.data.stats.nativeCompactionUsageRecords, 1);
  assert(entries().at(-1)!.data.stats.nativeCompactionTokens > 0);
});


test("native threshold guard ignores usage invalidated by a persisted context edit", async t => {
  const usage = { input: 5000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const seed = Array.from({ length: 4 }, (_, i) => [
    { role: "user", timestamp: i * 2 + 1, content: [image] },
    { ...fauxAssistantMessage("Done."), timestamp: i * 2 + 2, stopReason: "stop", usage },
  ]).flat() as Parameters<SessionManager["appendMessage"]>[0][];
  const options = { seed, seedEdit: { index: 6, replacement: { content: [image, { type: "text" as const, text: "Updated context" }] } }, contextWindow: 2400, reserveTokens: 500 };
  const native = await setup(t, { compactionGuard: false }, false, options);
  const guarded = await setup(t, undefined, false, options);
  await native.session.prompt("Continue without images");
  await guarded.session.prompt("Continue without images");
  assert.equal(native.bodies.length, 2);
  assert.equal(guarded.bodies.length, 1);
  assert.equal(imageCount(guarded.bodies[0]), 0);
  assert.equal(guarded.session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length, 0);
  await guarded.session.prompt("/image-context-trimmer status");
  assert(guarded.entries().at(-1)!.data.stats.deferredCompactions > 0);
});


test("cache-aware policy reduces simulated prefix-rebuild cost at the expense of bounded small-image traffic", async t => {
  const balanced = await setup(t, undefined, false, { warm: true });
  const immediate = await setup(t, { cacheAware: false }, false, { warm: true });
  for (const trial of [balanced, immediate]) {
    await trial.session.prompt("Inspect and collect the result", { images: [image] });
    for (let i = 0; i < 3; i++) await trial.session.prompt(`Text-only follow-up ${i}`);
    assert.equal(trial.bodies.length, 5);
  }
  assert.deepEqual(balanced.bodies.map(imageCount), [1, 1, 1, 1, 1]);
  assert.deepEqual(immediate.bodies.map(imageCount), [1, 1, 0, 0, 0]);
  const cost = (trial: typeof balanced) => trial.simulatedUsage.reduce((sum, usage) => sum + (2 * usage.input + 0.1 * usage.cached) / 1e6, 0);
  const bytes = (trial: typeof balanced) => trial.bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
  assert(cost(balanced) < cost(immediate));
  assert(bytes(balanced) > bytes(immediate));
  console.log(`Synthetic prefix-cache scenario: immediate $${cost(immediate).toFixed(6)} / ${bytes(immediate)} B; balanced $${cost(balanced).toFixed(6)} / ${bytes(balanced)} B (simulated input/cache cost, not billing).`);
});
