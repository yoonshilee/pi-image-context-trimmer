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

After a user task involving images settles, Pi displays a compact, expandable **Image Context Trimmer** card in the conversation. The card records the number of image blocks considered and replaced, the omitted Base64 bytes and reduction rate, and successful image recalls. Expand it with the tool-output expansion shortcut (default `Ctrl+O`) to see reference text size, context projection counts, bypass reasons, and Pi-reported assistant-response token usage.

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
  "display": "summary"
}
```

Set `display` to `"off"` to disable automatic cards. Slash commands override settings for the loaded session only; they do not edit the configuration file. Existing cards remain in the conversation, while cumulative counters restart on session load. SDK hosts can provide a different `configPath` in the extension factory options.

## How it works

1. New user attachments, tool-result images, and recalled images retain their original Pi image format. Each distinct recoverable image appears once during the active user task; subsequent identical blocks become short references without moving the first visible copy.
2. A successful final answer followed by a new user message marks the preceding task complete. Larger images from completed tasks become concise SHA-256 references. A successful tool call alone does not mark visual evidence as finished: all distinct active-task images remain available for multi-step inspection and comparison.
3. When exact historical visual details are needed, the model uses `recall_context_image` to retrieve the original from the current session branch. A new attachment or ordinary tool read of the same image also restores its visibility for the active task without requiring a separate recall. Pi may still normalize tool-result images according to the current model's limits.
4. Original session messages, system updates, and tool declarations remain unchanged. Errors, aborts, output-token limits, and additional user instructions do not end the active task. Images are retained when their exact source cannot be recovered, tools are disabled, or the model does not support images. Native WebSocket continuation, incremental Messages API threads, and other unverified model interfaces are bypassed.

The current branch's image content is indexed only for a projection involving images, so cloned request blocks can reuse the original image's cached SHA-256 digest. The index is request-scoped and checks exact MIME type and Base64 content; it does not retain images across branches or sessions.

No images are uploaded to external storage. The extension does not modify Pi's source code or session-file format, remove Base64 from persisted session files, or change Pi's automatic compaction policy. Pi evaluates native compaction before request-time context trimming. Re-examining a historical image may require an extra tool call, and replacing images can affect prompt caching. Recall is restricted to the current session branch; after compaction, a reference ID may no longer be present in the model context even when the original image remains in the session. The omitted-byte statistic counts Base64 characters in the context, not captured network traffic.

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

### Real-model validation (unreleased source candidate, 2026-11-27)

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

Distinct images remain available during the linked audit, while subsequent turns benefit from historical trimming. All additional model requests and recalls are included in the measured payload. Sizes are serialized JSON bytes, not captured network traffic. Total reported tokens decreased, but uncached input tokens increased in these runs, so the reduction does not establish billing savings. Results are specific to the tested synthetic workflow; they do not establish general accuracy, latency, or gateway resource savings. This candidate has not been published; the npm release remains v0.3.0.

## License

[MIT](LICENSE).
