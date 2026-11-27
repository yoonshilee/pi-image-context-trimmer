import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type AssistantMessage, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { imageId, projectImages, RECALL_TOOL } from "../src/image-context.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: (await readFile(new URL("./fixture.png", import.meta.url))).toString("base64") };
const model: Model<"openai-completions"> = {
  id: "fixture", name: "Fixture", provider: "image-context-test", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", input: ["text", "image"], reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};
const imageCount = (body: string, data = image.data) => body.split(data).length - 1;

async function runSession(t: TestContext, optimize: boolean, recallImage = false) {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    const recall = recallImage && bodies.length === 2;
    const delta = recall ? { role: "assistant", tool_calls: [{ index: 0, id: "call_recall", type: "function", function: { name: RECALL_TOOL, arguments: JSON.stringify({ id: imageId(image) }) } }] } : { role: "assistant", content: "Done." };
    const frame = (value: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame(delta, null) + frame({}, recall ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-context-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const localModel = { ...model, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: optimize ? [fileURLToPath(new URL("../src/index.ts", import.meta.url))] : [],
    extensionFactories: [pi => pi.registerProvider(localModel.provider, { baseUrl: localModel.baseUrl, api: localModel.api, apiKey: "local-fixture", models: [localModel] })],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: localModel, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  t.after(() => session.dispose());
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  if (optimize) assert(session.getActiveToolNames().includes(RECALL_TOOL));
  await session.prompt("Inspect this image", { images: [image] });
  await session.prompt("Follow up on the image");
  await session.prompt("Continue without further image inspection");
  assert.deepEqual(errors, []);
  assert(session.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(image.data)));
  return bodies;
}

test("real Pi SDK and local HTTP gateway: history reference, recall and original session image", async t => {
  const optimized = await runSession(t, true, true);
  assert.deepEqual(optimized.map(body => imageCount(body)), [1, 0, 1, 0]);
  assert(optimized[1].includes(imageId(image)));
  assert(optimized[3].includes(imageId(image)));
  const baseline = await runSession(t, false);
  assert.deepEqual(baseline.map(body => imageCount(body)), [1, 1, 1]);
  const noRecall = await runSession(t, true);
  assert.deepEqual(noRecall.map(body => imageCount(body)), [1, 0, 0]);
  const total = (bodies: string[]) => bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
  console.log(`SDK local HTTP: baseline ${total(baseline)} bytes / 3 requests; optimized ${total(noRecall)} bytes / 3 requests; optimized with recall ${total(optimized)} bytes / 4 requests.`);
});

test("installed OpenAI serializers replay Base64 on each request; image size and request count both matter", async () => {
  for (const api of ["openai-completions", "openai-responses"] as const) {
    for (const size of [256 * 1024, 1024 * 1024]) {
      const data = Buffer.alloc(size, 0x42).toString("base64");
      const user = { role: "user" as const, content: [{ ...image, data }], timestamp: 1 };
      const baseline: number[] = [];
      const optimized: number[] = [];
      const assistant: AssistantMessage = { role: "assistant", api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Image seen." }], stopReason: "stop", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      for (let round = 0; round < 3; round++) {
        const messages = [user, ...Array.from({ length: round }, (_, i) => [assistant, { role: "user" as const, content: `Follow up ${i}`, timestamp: i + 3 }]).flat()];
        for (const projection of [false, true]) {
          const context = { messages: projection ? projectImages(messages, () => true).messages : messages };
          const options = { apiKey: "local-fixture", maxRetries: 0, fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = typeof init?.body === "string" ? init.body : await new Request(_input, init).text();
            assert.equal(imageCount(body, data), projection && round > 0 ? 0 : 1);
            (projection ? optimized : baseline).push(Buffer.byteLength(body));
            return new Response(JSON.stringify({ error: { message: "intentional local measurement", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
          } };
          // These inputs contain simulated bytes and are intercepted before any network access.
          const transcript = normalizeContext({ messages: context.messages.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "system") });
          if (api === "openai-completions") await streamCompletions(model, transcript, options).result();
          else await streamResponses({ ...model, api }, transcript, options).result();
        }
      }
      assert.equal(baseline.length, 3);
      assert.equal(optimized.length, 3);
      assert(baseline.every(bytes => bytes >= data.length && bytes < data.length + 4096));
      assert(optimized.slice(1).every(bytes => bytes < 4096));
      console.log(`${api}, ${size / 1024} KiB raw: baseline ${baseline.join(", ")}; optimized ${optimized.join(", ")} bytes.`);
    }
  }
});
