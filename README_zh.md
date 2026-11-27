# pi-image-context-trimmer

[English](README.md) | 简体中文

减少 Pi 中图片 Base64 的重复传输，同时保留当前任务所需的视觉证据。符合经济性条件的历史图片会转换为可恢复引用。

## 安装

当前发布版本：`0.4.0`。

```sh
pi install npm:pi-image-context-trimmer
```

不修改全局设置，直接试用最新源码：

```sh
git clone https://github.com/yoonshilee/pi-image-context-trimmer.git
cd pi-image-context-trimmer
npm ci --ignore-scripts
pi -e ./src/index.ts
```

需要支持 `context_with_system` 的 Pi（已在 1.6.0 验证）。支持具备视觉能力的无状态 `openai-completions`、`openai-responses` 和 `anthropic-messages` API。明确使用 `openai-codex-responses` SSE 传输的 SDK 宿主可通过 `extensionFactories` 加载 `pi => imageContext(pi, { codexTransport: "sse" })`。原生增量/WebSocket 传输及未启用原图恢复工具的会话不执行裁剪。只使用 Agent Core 的宿主需自行接入 `src/image-context.ts` 的上下文转换和图片查找。

## 核心功能

- **保留证据：** 保留当前任务的不同图片，去除完全重复的图片，将符合条件的已完成任务图片转换为 SHA-256 引用。`recall_context_image` 可以从当前会话分支恢复原图。
- **保护缓存：** 按有序内容块比较前缀，权衡缓存重建成本和后续读取节省，选择经济的历史图片后缀，而非整批裁剪；考虑裁剪前后的计价分档。参考 [SoL-Pi](https://github.com/NVlabs/SoL-Pi/blob/097fad0105181dd93003eb4948a0d649a550bfe2/src/sol-pi/extensions/online-context-compact/economics.ts)。
- **限制传输：** 对暂缓裁剪的 Base64 设置单次及累计预算；上下文容量压力优先于暂缓策略。
- **协调压缩：** 在裁剪后空间足够时避免原生阈值压缩，不干预手动压缩及溢出恢复。

不引入外部图片存储、持久化历史改写或额外总结请求。单张图片缩放仍由 Pi 的 `inputLimits.images.resize` 负责。

## 配置与统计

在 `~/.pi/agent/image-context-trimmer.json`（或配置的 Pi Agent 目录）设置默认项：

```json
{
  "enabled": true,
  "display": "summary",
  "cacheAware": true,
  "cacheHorizonRequests": 4,
  "maxDeferredBase64Bytes": 1048576,
  "maxCumulativeDeferredBase64Bytes": 4194304,
  "compactionGuard": true
}
```

`cacheAware: false` 或任一字节预算设为 `0` 表示优先节省传输。请求次数仅是假定的计算范围，不是预测。符合条件的历史全部裁剪后，或缓存/会话上下文变更时累计预算重置，统计值仍累计。SDK 宿主可覆盖 `configPath`。

| 命令 | 效果 |
|---|---|
| `/image-context-trimmer status` | 展示加载以来的累计统计。 |
| `/image-context-trimmer on` / `off` | 开启/关闭裁剪。 |
| `/image-context-trimmer display summary` / `display off` | 开启/关闭自动任务卡片。 |

使用 `Ctrl+O` 展开 Pi 原生对话卡片，查看省略字节、原图恢复、报告的 Token 用量及缓存读取比例、预计回本次数、暂缓体积和压缩次数。卡片不进入模型上下文。命令作用于当前加载的会话，不修改配置文件。

## 验证

`npm run check` 通过类型检查及 54 项单元和 Pi SDK 集成测试。

### 最新真实模型对比

GPT-6.2 Sol（2026-11-27）：使用相同四轮问题、八张合成文档图片、精确匹配评分和关闭原生压缩的独立会话，重新执行完整的插件关闭/开启对照。两组均完成。

| 指标 | 未启用插件 | 启用插件 | 变化 |
|---|---:|---:|---:|
| JSON 请求体 | 18.47 MiB | 6.90 MiB | −62.7% |
| Base64 体积 | 18.40 MiB | 6.82 MiB | −62.9% |
| Zstd 请求体估算 | 12.94 MiB | 5.15 MiB | −60.2% |
| 图片块 | 32 | 11 | −65.6% |
| 报告的总 Token | 22,009 | 17,634 | −19.9% |
| 未命中缓存的输入 Token | 7,387 | 8,350 | +13.0% |
| 缓存读取 Token | 14,208 | 8,832 | −37.8% |
| 输出 Token | 414 | 452 | +9.2% |
| 实测耗时 | 160.9 s | 108.2 s | −32.7% |
| 目录费率估算费用 | $0.020335 | $0.022103 | +8.7% |
| 模型请求次数 | 13 | 13 | — |
| 正确字段 | 19/19 | 19/19 | — |

减少了 **62.7%** 请求 JSON 和 **19.9%** 总 Token，正确性和请求次数不变。两组均无工具失败；启用插件组一次原图恢复替代一次普通读取。未命中缓存的输入 Token 增加，因此按模型目录费率估算的费用也增加。费用按本次模型目录费率（每百万 Token：输入 $2、缓存读取 $0.10、输出 $10）估算，并非实际账单。Zstd 使用第 3 级重新计算，耗时为单次观测。本流程两次经济性判断均选择裁剪，未触发暂缓；压缩协调和选择性暂缓由下方 SDK 测试验证。

### 缓存与压缩验证（本地 SDK）

相同七次请求场景：较早的小图、较长文本和较晚的大图。

| 策略 | JSON 字节 | 模拟输入及缓存成本 |
|---|---:|---:|
| 整批决策 / 完整保留 | 1,254,477 | $0.033396 |
| 即时裁剪 | 489,353 | $0.051823 |
| 选择性裁剪 | **555,237** | **$0.033002** |

选择性裁剪相比整批决策减少 **55.7%** JSON 体积，相比即时裁剪降低 **36.3%** 模拟成本。压缩协调另在 SDK 场景中避免一次多余的总结请求（2 次请求变为 1 次）；累计预算与重新上传去重也验证通过。

JSON 与 Base64 是请求上下文测量，并非网络抓包。估算成本、模拟缓存节省和观察到的 Token 用量均不代表实际计费保证。原图仍保留在会话中，重新检查历史图片可能需要原图恢复调用。

[MIT](LICENSE)。
