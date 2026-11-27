# pi-image-context-trimmer

English | [简体中文](README_zh.md)

A Pi extension that replaces historical images and exact duplicates with recoverable references, reducing repeated request payloads for stateless model APIs while retaining distinct visual evidence throughout the active user task.

## Installation

Requires a Pi host with `context_with_system` support (tested with Pi 1.6.0). The extension targets stateless vision-capable models using the `openai-completions`, `openai-responses`, and `anthropic-messages` APIs.

```sh
pi install npm:pi-image-context-trimmer
```

Try the extension from source without modifying global settings:

```sh
git clone https://github.com/yoonshilee/pi-image-context-trimmer.git
cd pi-image-context-trimmer
npm ci --ignore-scripts
npm run check
pi -e ./src/index.ts
```

SDK applications can load the extension through `DefaultResourceLoader` and its `additionalExtensionPaths` option. Codex SDK hosts that explicitly use `transport: "sse"` can enable trimming by passing `pi => imageContext(pi, { codexTransport: "sse" })` in `extensionFactories`; this must match the host's SSE configuration. The default CLI does not trim Codex's native `auto` or WebSocket transport. Trimming is disabled when tools are explicitly disabled or `recall_context_image` is unavailable. Applications using only `pi-agent-core`, without the `pi-coding-agent` extension host, must integrate the context transformation and image lookup in `src/image-context.ts` themselves.

## Runtime statistics

After a user task involving images settles, Pi displays a compact, expandable **Image Context Trimmer** card in the conversation. The card records the number of image blocks considered and replaced, the omitted Base64 bytes and reduction rate, and successful image recalls. Expand it with the tool-output expansion shortcut (default `Ctrl+O`) to see reference text size, context projection counts, bypass reasons, Pi-reported input/cache-read/cache-write/output tokens, the latest cache-economic estimate, and native compaction counts and reported summary usage.

For example, a local two-turn smoke test rendered:

```text
Image Context Trimmer · Task
Image blocks 1 → 0 · 1 replaced · Base64 omitted 16.17 KiB (100.0%)
```

The card is a native, durable custom session entry rendered with `appendEntry` / `registerEntryRenderer`, not a tool call or a model message. It does not enter the model context or trigger an additional model request. Image blocks and Base64 are counted across context projections, including repeated occurrences of the same image, not unique files or captured network traffic. Reported tokens are observed usage, not estimated token savings.

| Command | Effect |
|---|---|
| `/image-context-trimmer status` | Show a cumulative card since the extension was loaded. |
| `/image-context-trimmer display summary` | Enable automatic task cards (default; `display on` also works). |
| `/image-context-trimmer display off` | Stop automatic cards; trimming and manual statistics still work. |
| `/image-context-trimmer on` / `off` | Enable or disable trimming independently of automatic cards. |

Set persistent defaults in `~/.pi/agent/image-context-trimmer.json` (or `image-context-trimmer.json` in your configured Pi agent directory):

```json
{
  "enabled": true,
  "display": "summary",
  "cacheAware": true,
  "cacheHorizonRequests": 4,
  "maxDeferredBase64Bytes": 1048576,
  "compactionGuard": true
}
```

Set `display` to `"off"` to disable automatic cards. Slash commands override settings for the loaded session only; they do not edit the configuration file. Existing cards remain in the conversation, while cumulative counters restart on session load. SDK hosts can provide a different `configPath` in the extension factory options.

## How it works

1. New user attachments, tool-result images, and recalled images retain their original Pi image format. Each distinct recoverable image appears once during the active user task; subsequent identical blocks become short references without moving the first visible copy.
2. A successful final answer followed by a new user message marks the preceding task complete. Larger recoverable images from completed tasks become eligible for concise SHA-256 references; the cache policy may defer a newly eligible replacement. A successful tool call alone does not mark visual evidence as finished: all distinct active-task images remain available for multi-step inspection and comparison.
3. When exact historical visual details are needed, the model uses `recall_context_image` to retrieve the original from the current session branch. A new attachment or ordinary tool read of the same image also restores its visibility for the active task without requiring a separate recall. Pi may still normalize tool-result images according to the current model's limits.
4. Original session messages, system updates, and tool declarations remain unchanged. Errors, aborts, output-token limits, and additional user instructions do not end the active task. Images are retained when their exact source cannot be recovered, tools are disabled, or the model does not support images. Native WebSocket continuation, incremental Messages API threads, and other unverified model interfaces are bypassed.

The current branch's image content is indexed only for a projection involving images, so cloned request blocks can reuse the original image's cached SHA-256 digest. The index is request-scoped and checks exact MIME type and Base64 content; it does not retain images across branches or sessions.

No images are uploaded to external storage. The extension does not modify Pi's source code or session-file format, or remove Base64 from persisted session files. Automatic threshold compaction can be deferred only through Pi's public pre-compaction event, as described below. Re-examining a historical image may require an extra tool call, and replacing images can affect prompt caching. Recall is restricted to the current session branch; after compaction, a reference ID may no longer be present in the model context even when the original image remains in the session. The omitted-byte statistic counts Base64 characters in the context, not captured network traffic.

## Cache-aware trimming and native compaction

The cache-aware policy adapts the break-even idea from [SoL-Pi Online Context Compact](https://github.com/NVlabs/SoL-Pi/blob/097fad0105181dd93003eb4948a0d649a550bfe2/src/sol-pi/extensions/online-context-compact/economics.ts) to recoverable image replacement, which does not require a summarization model call.

When the last successful request reported cache-read tokens within five minutes, the extension compares the projected context that preserves its deployed references with the context that also trims newly eligible historical images. It estimates the surviving cached prefix that would need rebuilding and the tokens removed per request, using Pi's token estimator calibrated against the last reported input size. The calculation uses Pi's current model catalog rates (including the applicable input tier and observed cache-write charges):

- Estimated rebuild cost = invalidated **retained** tokens × (cold input or cache-write rate − cache-read rate).
- Estimated future read savings = removed tokens per request × cache-read rate × assumed request horizon.
- Break-even requests = rebuild cost ÷ per-request read savings.

All rate calculations use the same per-million-token units. If the savings do not cover the rebuild cost, newly eligible historical images are retained for the next request. Existing references stay stable, active-task duplicate suppression continues, and no extra model call is made to estimate the horizon. A reported cache hit is evidence of a potentially warm cache, not proof of its future state. Missing price information, no observed cache hit, or a stale snapshot falls back to immediate trimming.

| Setting | Default | Effect |
|---|---:|---|
| `cacheAware` | `true` | Balance cache rebuild cost against future read savings. Set `false` for immediate bandwidth-first trimming. |
| `cacheHorizonRequests` | `4` | Assumed future requests including the next request; a positive integer, not a forecast of remaining work. |
| `maxDeferredBase64Bytes` | `1048576` | Force trimming when newly eligible Base64 reaches this per-request ceiling. Set `0` to always trim eligible history. |
| `compactionGuard` | `true` | Allow safe deferral of native threshold compaction. Set `false` to leave native compaction decisions entirely to Pi. |

Context pressure (at least 85% of Pi's reported context window or a deferred threshold compaction) also overrides economic deferral. The extension stores only compact message fingerprints and token estimates for the last request, and resets cache assumptions on session/model/branch changes and compaction. The displayed cost, token savings, and break-even point are heuristic estimates, not actual charges; serializer behavior and other context transformations may change the real cached prefix. The assumed horizon does not use a model-generated plan; consecutive decisions are not summed as realized savings.

Pi evaluates native compaction before request-time image trimming. At `session_before_compact`, the extension checks automatic **threshold** compaction against the fully trimmed context, the configured reserve, and the last valid reported usage. It only credits image reductions in portions estimated by Pi rather than subtracting historical images again from reported usage. If both estimates retain sufficient headroom (including an extra margin of 10% of the configured reserve), it defers that compaction and forces eligible image trimming on the next request. Otherwise Pi proceeds normally. Manual compaction and overflow recovery are never intercepted. No history is persistently rewritten, and no summary call is added by the extension.

## Single-image size

Pi 1.6.0 supports limiting the resolution, encoded size, and JPEG quality of newly attached images through `inputLimits.images.resize` in a model's configuration or `modelOverrides` in `models.json`. For example, a model used on bandwidth-constrained connections can be configured as follows:

```json
{
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

These are example values, not extension defaults. `maxBytes` measures the Base64-encoded size. Pi documents defaults of 2000 × 2000 pixels, 4.5 MiB encoded size, and JPEG quality 80. Resizing can reduce the legibility of text, screenshots, and charts; avoid applying aggressive limits globally without verifying the target visual task. Existing historical images are not automatically re-encoded by this setting.

## Validation

`npm run check` runs type checking and regression tests, including an actual Pi 1.6.0 SDK integration with a scripted local HTTP model. It verifies active-task evidence retention, within-task duplicate suppression, explicit recall and reattachment, exact source matching across cloned contexts, failed-request retention, preservation of system/tool updates, and native incremental continuation. Statistics tests verify task summaries, config and command overrides, file-backed session persistence, and that statistics never enter model requests. These local tests do not invoke paid models or measure visual-answer accuracy.

### Cache and compaction integration validation (local)

A deterministic prefix-cache simulator behind the actual Pi SDK compares immediate historical trimming and the default cache-aware policy on the same five requests. In the fixture, a small image precedes a long text result; each identical serialized message prefix receives simulated cached-read pricing. These are synthetic input/cache costs, not real model charges or answer-quality measurements.

| Metric | Immediate trimming | Cache-aware trimming |
|---|---:|---:|
| Model requests | 5 | 5 |
| Simulated input/cache cost | $0.046599 | $0.027743 (−40.5%) |
| Serialized JSON | 208,667 B | 258,080 B (+23.7%) |

A separate actual Pi SDK fixture triggers threshold compaction from untrimmed history. With the guard disabled, Pi makes a summary request and a normal model request; with the guard enabled, the image-trimmed context fits and Pi sends only the normal request. Manual compaction remains operational. The bandwidth-limit override, previously deployed references, missing/stale cache evidence, and the expanded statistics card are tested separately.

### Real-model validation (task-boundary strategy, commit `70807d8`, 2026-11-27)

The four-turn retrieval workflow uses eight synthetic document images (four target records and four distractors), including linked-document auditing, text-only analysis, historical image verification, and retrieval of a new adjustment record. The trimmed runs use their hash-verified complete baselines with the same models, prompts, fixtures, full-context SSE protocol, and exact-match scoring.

| Model | Without extension | With extension | JSON payload reduction | Correct fields (baseline / trimmed) |
|---|---:|---:|---:|---:|
| gpt-6.1-sol | 18.47 MiB | 6.90 MiB | **62.7%** | 19/19 · 19/19 |
| gpt-6.2-sol | 18.47 MiB | 6.90 MiB | **62.7%** | 19/19 · 19/19 |

| Metric | GPT-6.1 Sol (baseline → trimmed) | GPT-6.2 Sol (baseline → trimmed) |
|---|---:|---:|
| Image blocks sent | 32 → 11 | 32 → 11 |
| Correct user turns | 4/4 → 4/4 | 4/4 → 4/4 |
| Model requests | 13 → 13 | 13 → 13 |
| Original-image recalls | 0 → 1 | 0 → 1 |
| Reported total tokens | 21,787 → 17,355 (−20.3%) | 22,109 → 17,631 (−20.3%) |
| Uncached input tokens | 8,518 → 10,712 | 9,673 → 9,883 |
| Cache-read tokens | 12,928 → 6,272 | 12,032 → 7,296 |
| Output tokens | 341 → 371 | 404 → 452 |

| GPT-6.2 Sol user turn | Without extension | With extension | Payload reduction |
|---|---:|---:|---:|
| Linked-document audit | 5.37 MiB | 5.37 MiB | −0.06% |
| Text-only analysis | 1.79 MiB | 6.55 KiB | **99.6%** |
| Historical image verification | 3.88 MiB | 323.66 KiB | **91.8%** |
| New adjustment record | 7.45 MiB | 1.20 MiB | **83.8%** |

Distinct images remain available during the linked audit, while subsequent turns benefit from historical trimming. All additional model requests and recalls are included in the measured payload. Sizes are serialized JSON bytes, not captured network traffic. Total reported tokens decreased, but uncached input tokens increased in these runs, so the reduction does not establish billing savings. Results are specific to the tested synthetic workflow; they do not establish general accuracy, latency, or gateway resource savings. These complete results validate the task-boundary strategy at the indicated revision, not the newer cache-aware policy or compaction guard. The source changes remain unreleased; npm v0.3.0 is unchanged.

## License

[MIT](LICENSE).
