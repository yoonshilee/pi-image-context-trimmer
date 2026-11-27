import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import imageContext from "../src/index.ts";
import { imageId, RECALL_TOOL } from "../src/image-context.ts";
import { readTrimConfig, renderStatistics, STATS_ENTRY, type StatsEntryData, type TrimConfig } from "../src/statistics.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: (await readFile(new URL("./fixture.png", import.meta.url))).toString("base64") };
const imageCount = (body: string) => body.split(image.data).length - 1;

async function setup(t: TestContext, config?: TrimConfig, recall = false) {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    const shouldRecall = recall && bodies.length === 2;
    const delta = shouldRecall ? { role: "assistant", tool_calls: [{ index: 0, id: "stats-recall", type: "function", function: { name: RECALL_TOOL, arguments: JSON.stringify({ id: imageId(image) }) } }] } : { role: "assistant", content: "Done." };
    const frame = (choices: object[], usage?: object) => `data: ${JSON.stringify({ id: `stats-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices, usage })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame([{ index: 0, delta, finish_reason: null }]) + frame([{ index: 0, delta: {}, finish_reason: shouldRecall ? "tool_calls" : "stop" }]) + frame([], { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }) + "data: [DONE]\n\n");
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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture", models: [model] }), pi => imageContext(pi, { configPath })] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert(loader.getExtensions().extensions.some(ext => ext.entryRenderers?.has(STATS_ENTRY)));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")), noTools: "builtin" });
  t.after(() => session.dispose());
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  t.after(() => assert.deepEqual(errors, []));
  const entries = () => session.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === STATS_ENTRY ? [{ ...entry, data: entry.data as StatsEntryData }] : []);
  return { session, bodies, entries, configPath };
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
  assert.deepEqual(readTrimConfig(configPath), { enabled: true, display: "off" }, "slash commands change only current session");
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
  assert.deepEqual(readTrimConfig(file), { enabled: true, display: "summary" });
  await writeFile(file, '{"enabled":false}');
  assert.deepEqual(readTrimConfig(file), { enabled: false, display: "summary" });
  await writeFile(file, '{"enabled":"false"}');
  assert.throws(() => readTrimConfig(file), /enabled must be a boolean/);
  await writeFile(file, '{"display":"live"}');
  assert.throws(() => readTrimConfig(file), /display must be summary or off/);
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
