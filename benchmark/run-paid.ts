import { createHash } from "node:crypto";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, VERSION, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { getOpenAICodexWebSocketDebugStats, type OpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { RECALL_TOOL, supportsProjection } from "../src/image-context.ts";
import imageContext from "../src/index.ts";

interface Fixture { name: string; file: string; width: number; height: number; bytes: number; sha256: string; top: string; bottom: string }
interface RequestRecord { codexZstdBytes?: number; maxOutputTokens?: number; jsonBytes: number; imageBlocks: number; base64Bytes: number; startMs: number; headersMs?: number; httpStatus?: number; completedMs?: number; stopReason?: string; usage?: Omit<Usage, "cost"> & { billedCost?: number }; toolCalls?: string[]; toolFailures?: number; errorStatus?: string }
interface Round { name: string; prompt: string; expected: string; answer?: string; correct?: boolean; elapsedMs?: number; interrupted?: boolean; requests: RequestRecord[] }
interface Trial { transport?: "sse" | "auto"; websocket?: Pick<OpenAICodexWebSocketDebugStats, "requests" | "fullContextRequests" | "deltaRequests" | "connectionsCreated" | "connectionsReused" | "sseFallbacks">; provider: string; model: string; api: string; fixture: string; mode: "baseline" | "trimmed" | "native"; rounds: Round[]; extensionErrors: number; complete: boolean; elapsedMs?: number }

const benchmarkDir = fileURLToPath(new URL(".", import.meta.url));
const fixtures: Fixture[] = JSON.parse(await readFile(join(benchmarkDir, "fixtures/manifest.json"), "utf8"));
const args = process.argv.slice(2);
const fixtureArg = args.find(arg => arg.startsWith("--fixture="))?.slice(10);
if (fixtureArg && !fixtures.some(fixture => fixture.name === fixtureArg)) throw new Error("Unknown fixture");
const selectedFixtures = fixtureArg ? fixtures.filter(fixture => fixture.name === fixtureArg) : fixtures;
const nativeAuto = args.includes("--codex-auto");
const targets = args.filter(arg => !arg.startsWith("--fixture=") && arg !== "--codex-auto");
if (!targets.length || targets.length > 2 || targets.some(target => !target.includes("/"))) {
  throw new Error("Pass one or two configured provider/model identifiers. This command makes paid requests.");
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(benchmarkDir, "results", `${stamp}-paid.json`);
const systemPrompt = "Answer the current question only, using the requested exact four-digit or numeric format without Markdown. Never volunteer other numbers from an image. If a question needs visual details not visible in the current input and an image reference is present, use the available image recall tool before answering. Do not guess from a reference ID.";
const trials: Trial[] = [];
let interrupted = false;
let activeSession: AgentSession | undefined;
const interrupt = () => { interrupted = true; void activeSession?.abort(); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const skipped: { target: string; reason: string }[] = [];
const paidConfig = { outputTokenCap: 512, thinkingLevel: "off", providerRetries: 0, agentRetries: 0, cacheWarming: "off", timeoutMs: 60_000, maxRequestsPerRound: 3 };
const temp = await mkdtemp(join(tmpdir(), "pi-image-trimmer-paid-"));
const agentDir = join(temp, "agent");
await mkdir(agentDir);
const runtime = await ModelRuntime.create({ authPath: join(targets.some(target => target.startsWith("openai-codex/")) ? getAgentDir() : agentDir, "auth.json"), modelsPath: join(getAgentDir(), "models.json"), modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false });

async function persist() {
  await writeFile(output, JSON.stringify({ startedAt: stamp, piVersion: VERSION, systemPrompt, paidConfig, fixtures: selectedFixtures, targets, trials, skipped, ...(interrupted ? { interrupted: true, interruptionReason: "Stopped before scheduling further requests" } : {}) }, null, 2) + "\n");
}

function usageRecord(usage: Usage): RequestRecord["usage"] {
  const { cost, ...tokens } = usage;
  return { ...tokens, ...(cost.totalFromProvider ? { billedCost: cost.total } : {}) };
}

function setupMetrics(getRound: () => Round | undefined, codexSse: boolean): (pi: ExtensionAPI) => void {
  return pi => {
    pi.on("before_provider_request", event => {
      const round = getRound();
      if (!round) return;
      const payload = event.payload as { max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number };
      const body = JSON.stringify(event.payload);
      const images = [...body.matchAll(/data:image\/[^;"\s]+;base64,([A-Za-z0-9+/=]+)/g)];
      round.requests.push({ ...(codexSse ? { codexZstdBytes: zstdCompressSync(body, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } }).byteLength } : {}), maxOutputTokens: payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens, jsonBytes: Buffer.byteLength(body), imageBlocks: images.length, base64Bytes: images.reduce((sum, match) => sum + match[1].length, 0), startMs: performance.now() });
    });
    pi.on("after_provider_response", event => {
      const request = getRound()?.requests.at(-1);
      if (request) { request.httpStatus = event.status; request.headersMs = Math.round(performance.now() - request.startMs); }
    });
    pi.on("turn_end", event => {
      const round = getRound();
      const request = round?.requests.at(-1);
      if (!request || event.message.role !== "assistant") return;
      request.completedMs = Math.round(performance.now() - request.startMs);
      request.stopReason = event.message.stopReason;
      request.usage = usageRecord(event.message.usage);
      request.toolCalls = event.message.content.filter(block => block.type === "toolCall").map(block => block.name);
      request.toolFailures = event.toolResults.filter(result => result.isError).length;
      if (event.message.stopReason === "error") request.errorStatus = event.message.errorMessage?.match(/\b[45]\d{2}\b/)?.[0] ?? "unknown";
      if (round && round.requests.length >= paidConfig.maxRequestsPerRound && event.continue) return { continue: false };
    });
  };
}

async function runTrial(model: Model<string>, fixture: Fixture, mode: Trial["mode"]): Promise<Trial> {
  const imageBytes = await readFile(join(benchmarkDir, "fixtures", fixture.file));
  if (imageBytes.length !== fixture.bytes || createHash("sha256").update(imageBytes).digest("hex") !== fixture.sha256) throw new Error("Fixture hash mismatch");
  const image: ImageContent = { type: "image", mimeType: "image/png", data: imageBytes.toString("base64") };
  const codex = model.api === "openai-codex-responses";
  const codexSse = codex && mode !== "native";
  const transport = codex ? (codexSse ? "sse" as const : "auto" as const) : undefined;
  const trial: Trial = { transport, provider: model.provider, model: model.id, api: model.api, fixture: fixture.name, mode, rounds: [], extensionErrors: 0, complete: false };
  trials.push(trial);
  const start = performance.now();
  const cwd = await mkdtemp(join(temp, "trial-"));
  let currentRound: Round | undefined;
  const settingsManager = SettingsManager.inMemory({ transport, compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: paidConfig.timeoutMs } }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, systemPrompt, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: mode === "trimmed" && !codexSse ? [fileURLToPath(new URL("../src/index.ts", import.meta.url))] : [], extensionFactories: [...(mode === "trimmed" && codexSse ? [(pi: ExtensionAPI) => imageContext(pi, { codexTransport: "sse" })] : []), setupMetrics(() => currentRound, codexSse)] });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error("Benchmark extension failed to load");
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: { ...model, maxTokens: Math.min(model.maxTokens, paidConfig.outputTokenCap) }, thinkingLevel: "off", resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
  activeSession = session;
  try {
    await session.bindExtensions({ onError: () => { trial.extensionErrors++; } });
    if (mode === "trimmed" && !session.getActiveToolNames().includes(RECALL_TOOL)) throw new Error("Trimming tool is not active");
    const rounds: Omit<Round, "requests">[] = [
      { name: "initial", prompt: "Read only the four-digit number in the upper white rectangle. Return exactly that number and do not mention the lower number.", expected: fixture.top },
      { name: "text", prompt: "Ignore the image for this question. Calculate 17 + 25 and return only the number.", expected: "42" },
      { name: "recall", prompt: "Read the four-digit number in the lower white rectangle of the original image. If only an image reference remains, use the available recall tool before answering. Return exactly the four digits.", expected: fixture.bottom },
    ];
    for (const definition of rounds) {
      if (interrupted) break;
      currentRound = { ...definition, requests: [] };
      trial.rounds.push(currentRound);
      const roundStart = performance.now();
      const timer = setTimeout(() => { if (currentRound) currentRound.interrupted = true; void session.abort(); }, paidConfig.timeoutMs * 2);
      try {
        await session.prompt(definition.prompt, definition.name === "initial" ? { images: [image] } : undefined);
      } finally { clearTimeout(timer); }
      if (interrupted) currentRound.interrupted = true;
      const final = session.messages.findLast(message => message.role === "assistant");
      if (final?.role === "assistant") {
        currentRound.answer = final.content.filter(block => block.type === "text").map(block => block.text).join("").trim().slice(0, 100);
        currentRound.correct = final.stopReason === "stop" && currentRound.answer === currentRound.expected;
      }
      currentRound.elapsedMs = Math.round(performance.now() - roundStart);
      for (const request of currentRound.requests) request.startMs = Math.round(request.startMs - roundStart);
      const reason = currentRound.requests.at(-1)?.stopReason;
      console.log(`${model.provider}/${model.id} ${fixture.name} ${mode} ${definition.name}: ${currentRound.correct ? "PASS" : "FAIL"}, ${currentRound.requests.length} calls, ${currentRound.requests.map(r => r.jsonBytes).join("/")} B, ${currentRound.elapsedMs} ms${reason === "error" ? `, error ${currentRound.requests.at(-1)?.errorStatus}` : ""}`);
      await persist();
      if (!currentRound.requests.length || reason === "error" || reason === "aborted" || currentRound.interrupted) break;
    }
    trial.complete = trial.rounds.length === 3 && trial.rounds.every(round => round.requests.length && !round.interrupted && round.requests.at(-1)?.stopReason === "stop");
  } finally {
    if (mode === "native") {
      const stats = getOpenAICodexWebSocketDebugStats(session.sessionManager.getSessionId());
      if (stats) {
        const { requests, fullContextRequests, deltaRequests, connectionsCreated, connectionsReused, sseFallbacks } = stats;
        trial.websocket = { requests, fullContextRequests, deltaRequests, connectionsCreated, connectionsReused, sseFallbacks };
      }
    }
    session.dispose();
    activeSession = undefined;
    trial.elapsedMs = Math.round(performance.now() - start);
    await persist();
  }
  return trial;
}

try {
  console.log(`Pi ${VERSION}; paid benchmark output: ${output}`);
  for (const target of targets) {
    if (interrupted) break;
    const i = target.indexOf("/");
    const model = runtime.getModel(target.slice(0, i), target.slice(i + 1));
    if (!model || (nativeAuto && model.api !== "openai-codex-responses") || !model.input.includes("image") || !supportsProjection(model.api, model.api === "openai-codex-responses" ? "sse" : undefined) || !runtime.getProviderAuthStatus(model.provider).configured) {
      skipped.push({ target, reason: "Not a configured, authenticated stateless vision model" }); await persist(); continue;
    }
    for (const [index, fixture] of selectedFixtures.entries()) {
      if (interrupted) break;
      const modes: Trial["mode"][] = nativeAuto ? ["native"] : index % 2 === 0 ? ["baseline", "trimmed"] : ["trimmed", "baseline"];
      let providerFailed = false;
      for (const mode of modes) {
        if (interrupted) break;
        const trial = await runTrial(model, fixture, mode);
        if (trial.rounds[0]?.requests.at(-1)?.stopReason === "error" || !trial.rounds[0]?.requests.length) { providerFailed = true; break; }
      }
      if (providerFailed) { skipped.push({ target, reason: "Initial paid request failed; remaining trials for this model were not sent" }); await persist(); break; }
    }
  }
} finally {
  await persist();
  await runtime.settleCredentialWrites();
  await rm(temp, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
console.log(`Paid benchmark results: ${output}`);
