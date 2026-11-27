# pi-image-context-trimmer

English | [简体中文](README_zh.md)

A Pi extension that replaces images from successful model requests with recoverable references, reducing repeated request payloads and bandwidth usage for stateless model APIs, including within a single user turn.

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

In Pi's interactive interface, use `/image-context-trimmer status` to view eligibility, replacement counts, and omitted Base64 bytes for the current session. Use `/image-context-trimmer off` to restore untrimmed requests and `/image-context-trimmer on` to enable trimming again.

SDK applications can load the extension through `DefaultResourceLoader` and its `additionalExtensionPaths` option. Codex SDK hosts that explicitly use `transport: "sse"` can enable trimming by passing `pi => imageContext(pi, { codexTransport: "sse" })` in `extensionFactories`; this must match the host's SSE configuration. The default CLI does not trim Codex's native `auto` or WebSocket transport. Trimming is disabled when tools are explicitly disabled or `recall_context_image` is unavailable. Applications using only `pi-agent-core`, without the `pi-coding-agent` extension host, must integrate the context transformation and image lookup in `src/image-context.ts` themselves.

## How it works

1. New user attachments and tool-result images visible on the current session branch are sent in Pi's original image format. Multiple new images can be sent together; recoverable exact duplicates appear once per request.
2. Once a model response finishes successfully, either with a final answer or tool calls, larger images preceding that response become short references containing their SHA-256 identifiers in the next request. This also applies within a single user turn. Ordinary tool reads that return an already processed identical image reuse its reference instead of uploading it again.
3. When exact visual details are required, the model uses `recall_context_image`. The extension finds and returns the original image from the current session branch for the next model request, even if it was already processed. Recall multiple images in one tool batch to compare them together. After another successful response, recalled images become references again. Pi may still normalize tool-result images according to the current model's limits.
4. Original session messages, system updates, and tool declarations remain unchanged. Errors, aborts, output-token limits, and additional user instructions do not mark new images as processed; images since the last successful response remain available for retry. Images are also retained when their source cannot be recovered, tools are disabled, or the model does not support images. The extension bypasses native WebSocket continuation, incremental Messages API threads, and other unverified model interfaces.

No images are uploaded to external storage. The extension does not modify Pi's source code or session-file format, and it does not remove Base64 from persisted session files. Re-examining a processed image may require an extra tool call, including within the same user turn, and replacing images can affect prompt caching. Recall is restricted to the current session branch; after compaction, a reference ID may no longer be present in the model context even when the original image remains in the session. The omitted-byte statistic counts Base64 characters in the context, not captured network traffic.

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

`npm run check` runs type checking and regression tests, including an actual Pi 1.6.0 SDK integration with a scripted local HTTP model. It verifies trimming between model requests within one user turn, repeated reads, explicit recall, multiple pending images, failed-request retention, preservation of system/tool updates, and native incremental continuation. These tests do not invoke paid models or measure visual-answer accuracy.

### v0.2.0 real-model validation (2026-11-27)

The measurements in this section are from the tagged v0.2.0 release, which trims images after completed user turns. They do not measure within-turn trimming; that behavior is verified by the local tests above and has not been evaluated with real models.

The latest completed comparisons per model and scenario use full-context SSE requests, empty starting sessions, the same prompts and fixtures, and exact-match scoring. The latest `gpt-6.2-sol` trimmed run uses its hash-verified complete baseline with the same benchmark protocol.

| Model | Scenario | Without extension | With extension | JSON payload reduction | Correct answers (baseline / trimmed) |
|---|---|---:|---:|---:|---:|
| gpt-6.1-sol | Small image, three turns | 931.56 KiB | 627.51 KiB | **32.6%** | 3/3 · 3/3 |
| gpt-6.1-sol | Large image, three turns | 3.54 MiB | 2.36 MiB | **33.2%** | 3/3 · 3/3 |
| gpt-6.1-sol | Multi-step retrieval, four turns | 18.47 MiB | 6.90 MiB | **62.7%** | 19/19 · 19/19 fields |
| gpt-6.2-sol | Multi-step retrieval, four turns | 18.47 MiB | 6.90 MiB | **62.7%** | 19/19 · 19/19 fields |

The multi-step workflow uses eight synthetic document images (four target records and four distractors) and four tasks: a linked-document audit, text-only analysis, historical image verification, and retrieval of a new adjustment record.

| Latest GPT-6.2 Sol retrieval metrics | Without extension | With extension | Change |
|---|---:|---:|---:|
| Image blocks sent | 32 | 11 | **−65.6%** |
| Correct user turns | 4/4 | 4/4 | Unchanged |
| Model requests | 13 | 13 | Unchanged |
| Original-image recalls | 0 | 1 | +1 |
| Reported total tokens | 22,109 | 17,707 | −19.9% |

| User turn | Without extension | With extension | Payload reduction |
|---|---:|---:|---:|
| Linked-document audit | 5.37 MiB | 5.37 MiB | ≈0% |
| Text-only analysis | 1.79 MiB | 6.72 KiB | **99.6%** |
| Historical image verification | 3.88 MiB | 324.01 KiB | **91.8%** |
| New adjustment record | 7.45 MiB | 1.20 MiB | **83.8%** |

In these v0.2.0 measurements, the initial audit retains its acquired images until the task finishes. Subsequent turns avoid repeatedly transmitting historical images; the measured payload includes every additional model request and recall. Sizes are serialized JSON bytes rather than captured network traffic. Results are specific to the completed synthetic scenarios, not estimates of general accuracy, latency, gateway resources, or billing.

## License

[MIT](LICENSE).
