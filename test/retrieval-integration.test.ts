import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import imageContext from "../src/index.ts";
import { imageId, RECALL_TOOL } from "../src/image-context.ts";
import { gradeAnswer, installRequestLimit, retrievalTools, type RetrievalCorpus, type RetrievalEvent } from "./fixtures/retrieval-case.ts";

const corpus = JSON.parse(await readFile(new URL("./fixtures/retrieval-corpus.json", import.meta.url), "utf8")) as RetrievalCorpus;
const fixture = await readFile(new URL("./fixture.png", import.meta.url));
const images = new Map<string, ImageContent>(corpus.documents.map(document => {
  // A valid PNG text chunk gives each otherwise identical test image a distinct identity.
  const type = Buffer.from("tEXt");
  const data = Buffer.from(`Document\0${document.id}`);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  const bytes = Buffer.concat([fixture.subarray(0, -12), chunk, fixture.subarray(-12)]);
  return [document.id, { type: "image", mimeType: "image/png", data: bytes.toString("base64") }];
}));
const idByImage = new Map([...images].map(([id, image]) => [imageId(image), id]));
type Step = { tool: string; args: Record<string, string> } | { answer: string };
const search = (args: Record<string, string>): Step => ({ tool: "search_records", args });
const read = (id: string): Step => ({ tool: "read_record", args: { id } });
const answer = (round: number): Step => ({ answer: JSON.stringify(corpus.rounds[round].expected) });

async function run(t: TestContext, trimmed: boolean, limit?: number) {
  const steps: Step[] = [search({ lot: "A17", kind: "order" }), read("doc-201"), search({ lot: "A17", reference: "4831" }), read("doc-317"), search({ lot: "A17", reference: "7294" }), read("doc-509"), answer(0), answer(1),
    ...(trimmed ? [{ tool: RECALL_TOOL, args: { id: imageId(images.get("doc-509")!) } }] : []), answer(2), search({ lot: "A17", kind: "adjustment" }), read("doc-624"), answer(3)];
  const sentImages: string[][] = [];
  let totalBytes = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    totalBytes += Buffer.byteLength(body);
    sentImages.push([...body.matchAll(/data:(image\/[^;"\s]+);base64,([A-Za-z0-9+/=]+)/g)].map(match => idByImage.get(imageId({ type: "image", mimeType: match[1], data: match[2] })) ?? "unknown"));
    const step = steps[sentImages.length - 1];
    if (!step) { res.writeHead(400); res.end("Unexpected model request"); return; }
    const delta = "tool" in step ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${sentImages.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } : { role: "assistant", content: step.answer };
    const frame = (value: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${sentImages.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame(delta, null) + frame({}, "tool" in step ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cwd = await mkdtemp(join(tmpdir(), "pi-retrieval-test-"));
  const agentDir = join(cwd, "agent"); await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "retrieval-fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", input: ["text", "image"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const trace: RetrievalEvent[] = [];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, systemPrompt: "Audit the visual register.", noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture", models: [model] }), retrievalTools(corpus.documents, images, event => trace.push(event)), ...(trimmed ? [(pi: ExtensionAPI) => imageContext(pi, { configPath: join(agentDir, "image-context-trimmer.json") })] : [])] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
  t.after(() => session.dispose());
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  if (limit !== undefined) {
    const budget = { requests: sentImages, maxRequests: limit, limitReached: false };
    installRequestLimit(session, () => budget);
    await session.prompt(corpus.rounds[0].prompt);
    assert.equal(sentImages.length, limit);
    assert.equal(budget.limitReached, true);
    assert.deepEqual(errors, []);
    return { sentImages, totalBytes, trace };
  }
  for (const round of corpus.rounds) {
    const before = session.messages.length;
    await session.prompt(round.prompt);
    const last = session.messages.slice(before).findLast(message => message.role === "assistant");
    assert(last?.role === "assistant" && last.stopReason === "stop");
    const text = last.content.filter(block => block.type === "text").map(block => block.text).join("");
    assert(gradeAnswer(text, round.expected).correct);
  }
  assert.deepEqual(errors, []);
  assert.equal(sentImages.length, steps.length);
  const originals = session.sessionManager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? entry.message.content.filter(block => block.type === "image").map(imageId) : []);
  for (const id of ["doc-201", "doc-317", "doc-509", "doc-624"]) assert(originals.includes(imageId(images.get(id)!)));
  return { sentImages, totalBytes, trace };
}

test("real Pi SDK retains active retrieval evidence together and trims completed turns", async t => {
  const baseline = await run(t, false);
  const trimmed = await run(t, true);
  assert.deepEqual(baseline.trace, trimmed.trace);
  assert.deepEqual(baseline.trace.filter(event => event.tool === "read_record").flatMap(event => event.records), ["doc-201", "doc-317", "doc-509", "doc-624"]);
  assert.deepEqual(baseline.sentImages.map(items => items.length), [0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 3, 4]);
  assert.deepEqual(trimmed.sentImages, [[], [], ["doc-201"], ["doc-201"], ["doc-201", "doc-317"], ["doc-201", "doc-317"], ["doc-201", "doc-317", "doc-509"], [], [], ["doc-509"], [], [], ["doc-624"]]);
  assert(trimmed.totalBytes < baseline.totalBytes);
  console.log(`Retrieval local HTTP: baseline ${baseline.totalBytes} B / ${baseline.sentImages.flat().length} image blocks; trimmed ${trimmed.totalBytes} B / ${trimmed.sentImages.flat().length} image blocks.`);
});


test("retrieval request ceiling ends the natural tool loop without an extra request", async t => {
  const limited = await run(t, true, 3);
  assert.equal(limited.sentImages.length, 3);
});
