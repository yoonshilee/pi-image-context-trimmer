# pi-image-context-trimmer

English | [简体中文](README_zh.md)

A Pi extension that replaces historical images from completed turns with recoverable references, reducing repeated request payloads and bandwidth usage for stateless model APIs.

## Installation

Tested with Pi 1.6.0. By default, the extension targets vision-capable models using the `openai-completions` and `openai-responses` APIs.

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

1. New user attachments and tool-result images visible on the current session branch are sent in Pi's original image format.
2. All distinct images acquired or recalled during the current user turn remain available together across tool calls. Once a successful final response is followed by a new user prompt, larger historical images become short references containing their SHA-256 identifiers. Recoverable exact duplicates within a request can also be replaced by references.
3. When exact visual details are required, the model uses `recall_context_image`. The extension finds and returns the original image from the current session branch. That image remains available throughout the current turn and can be trimmed when a later turn begins. Pi may still normalize tool-result images according to the current model's limits.
4. Original session messages remain unchanged. Unfinished or failed turns retain their visual evidence; images are also retained when their source cannot be recovered, tools are disabled, or the model does not support images. The extension bypasses native WebSocket incremental continuation and other unverified model interfaces.

No images are uploaded to external storage. The extension does not modify Pi's source code or session-file format, and it does not remove Base64 from persisted session files. Re-examining an older image may require an extra tool call, and changing the context prefix can affect prompt caching. The omitted-byte statistic counts Base64 characters in the context, not captured network traffic.

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

`npm run check` runs type checking and regression tests, including an actual Pi 1.6.0 SDK integration with a scripted local HTTP model. It verifies that distinct images remain available during a multi-step retrieval chain, completed turns are trimmed, older images can be recalled, and original session data is preserved. These tests do not invoke paid models.

### Multi-step visual retrieval (2026-11-27)

Model: `kimi-k3`. The scenario uses eight synthetic document images (four target records and four distractors) and four user turns: a linked-document audit, text-only analysis, historical image verification, and a new adjustment record. Both runs use the same model, frozen corpus, prompts, and exact-match scoring. The baseline is a previously recorded complete run without the extension.

| Metric | Without extension | With extension | Change |
|---|---:|---:|---:|
| Total JSON request payload | 15.47 MiB | 6.89 MiB | **−55.5%** |
| Image blocks sent | 25 | 11 | **−56.0%** |
| Correct rounds | 4/4 | 4/4 | Unchanged |
| Correct answer fields | 19/19 | 19/19 | Unchanged |
| Model requests | 12 | 13 | +1 |
| Original-image recalls | 0 | 1 | +1 |
| Reported total tokens | 25,063 | 24,362 | −2.8% |

| User turn | Without extension | With extension | Payload reduction |
|---|---:|---:|---:|
| Linked-document audit | 5.36 MiB | 5.37 MiB | −0.1% |
| Text-only analysis | 1.79 MiB | 5.85 KiB | **99.7%** |
| Historical image verification | 1.79 MiB | 321.95 KiB | **82.4%** |
| New adjustment record | 6.54 MiB | 1.20 MiB | **81.6%** |

The initial audit keeps all three acquired images visible until the task finishes. Later turns avoid repeatedly transmitting those images, with one explicit recall when historical visual details are needed. Payload measurements include all model requests, tool definitions, and recall overhead, and represent serialized JSON bytes rather than captured network traffic. This is one completed synthetic workflow with a nonconcurrent historical baseline, not a general accuracy, latency, gateway resource, or billing estimate.

## License

[MIT](LICENSE).
