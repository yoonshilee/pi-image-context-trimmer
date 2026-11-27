"""Render the paid benchmark's recorded requests as Markdown and SVG."""

from collections import defaultdict
from html import escape
from pathlib import Path
import json

RESULTS = Path(__file__).parent / "results"


def total(trial):
    """Aggregate recorded requests and exact-answer outcomes for a trial.

    Args:
        trial: A recorded baseline or trimmed trial.

    Returns:
        Metrics covering all user rounds and extra model requests.
    """
    rounds = trial["rounds"]
    requests = [request for round_ in rounds for request in round_["requests"]]
    return {
        "bytes": sum(request["jsonBytes"] for request in requests),
        "calls": len(requests),
        "seconds": sum(round_.get("elapsedMs", 0) for round_ in rounds) / 1000,
        "correct": sum(bool(round_.get("correct")) for round_ in rounds),
        "questions": len(rounds),
        "recalls": sum(request.get("toolCalls", []).count("recall_context_image") for request in requests),
        "tokens": sum(request.get("usage", {}).get("totalTokens", 0) for request in requests),
    }


def size_str(size):
    """Format request sizes with an explicit binary size unit.

    Args:
        size: Request size in bytes.

    Returns:
        A human-readable size.
    """
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.2f} MiB"
    if size >= 1024:
        return f"{size / 1024:.2f} KiB"
    return f"{size} B"


def model_label(trial):
    """Return a short human-readable label for a benchmark target.

    Args:
        trial: A recorded model trial.

    Returns:
        The model name with its transport when relevant.
    """
    transport = " (SSE)" if trial.get("transport") == "sse" else ""
    return f"{trial['model']}{transport}"


def svg_chart(pairs, chinese=False):
    """Create a horizontal paired-bar chart for completed trials.

    Args:
        pairs: Complete baseline and trimmed pairs with aggregate metrics.
        chinese: Whether to render Chinese rather than English labels.

    Returns:
        SVG source for the visual comparison.
    """
    width = 900
    height = 105 + len(pairs) * 78
    maximum = max((metrics["bytes"] for _, _, a, b in pairs for metrics in (a, b)), default=1)
    title = "付费模型实测 · 累计 JSON 请求体" if chinese else "Real-model benchmark · Total JSON request payload"
    baseline_label = "原版" if chinese else "Baseline"
    trimmed_label = "裁剪后（含恢复调用）" if chinese else "Trimmed (including recall)"
    content = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{title}">',
        '<rect width="100%" height="100%" rx="12" fill="#f8fafc"/>',
        '<g font-family="system-ui, sans-serif" fill="#182230">',
        f'<text x="24" y="34" font-weight="700" font-size="20">{title}</text>',
        f'<rect x="25" y="52" width="16" height="12" rx="2" fill="#64748b"/><text x="49" y="63" font-size="13">{baseline_label}</text>',
        f'<rect x="130" y="52" width="16" height="12" rx="2" fill="#087f8c"/><text x="154" y="63" font-size="13">{trimmed_label}</text>',
    ]
    for index, (trial, _, baseline, trimmed) in enumerate(pairs):
        y = 85 + index * 78
        image_label = ("小图" if trial["fixture"] == "small" else "大图") if chinese else trial["fixture"]
        label = escape(f"{model_label(trial)} · {image_label}")
        savings = 100 * (1 - trimmed["bytes"] / baseline["bytes"])
        content.append(f'<text x="24" y="{y + 19}" font-size="14" font-weight="600">{label}</text>')
        for offset, metrics, color in ((0, baseline, "#64748b"), (26, trimmed, "#087f8c")):
            bar = max(1, 345 * metrics["bytes"] / maximum)
            content.append(f'<rect x="300" y="{y + offset}" width="{bar:.2f}" height="20" rx="3" fill="{color}"/>')
            content.append(f'<text x="660" y="{y + offset + 15}" font-size="13">{size_str(metrics["bytes"])}</text>')
        reduction_label = f"减少 {savings:.1f}%" if chinese else f"{savings:.1f}% reduction"
        content.append(f'<text x="24" y="{y + 41}" font-size="13" fill="#475569">{reduction_label}</text>')
    content.append('</g></svg>')
    return "\n".join(content) + "\n"


def main():
    """Write a visual chart and print README-ready Markdown tables."""
    grouped = defaultdict(dict)
    native = []
    for path in sorted(RESULTS.glob("*-paid.json")):
        data = json.loads(path.read_text())
        for trial in data["trials"]:
            if trial["mode"] == "native":
                native.append(trial)
                continue
            if not trial["complete"]:
                continue
            key = (path.name, trial["provider"], trial["model"], trial["fixture"])
            grouped[key][trial["mode"]] = trial
    pairs = []
    for modes in grouped.values():
        if set(modes) == {"baseline", "trimmed"}:
            a, b = modes["baseline"], modes["trimmed"]
            pairs.append((a, b, total(a), total(b)))
    (RESULTS / "paid-comparison.svg").write_text(svg_chart(pairs))
    (RESULTS / "paid-comparison_zh.svg").write_text(svg_chart(pairs, chinese=True))
    print("| 模型 / 图片 | 原版请求体 | 裁剪后请求体 | 请求体减少 | 模型调用 原/裁 | 耗时 原/裁 | 正确题数 原/裁 | 恢复原图次数 |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for trial, _, a, b in pairs:
        print(f"| {model_label(trial)} / {trial['fixture']} | {size_str(a['bytes'])} | {size_str(b['bytes'])} | **{100 * (1 - b['bytes'] / a['bytes']):.1f}%** | {a['calls']}/{b['calls']} | {a['seconds']:.2f}/{b['seconds']:.2f} s | {a['correct']}/{a['questions']} · {b['correct']}/{b['questions']} | {b['recalls']} |")
    if pairs:
        a_sums = {key: sum(a[key] for _, _, a, _ in pairs) for key in pairs[0][2]}
        b_sums = {key: sum(b[key] for _, _, _, b in pairs) for key in pairs[0][3]}
        a, b = a_sums, b_sums
        print(f"| **完整配对合计** | **{size_str(a['bytes'])}** | **{size_str(b['bytes'])}** | **{100 * (1 - b['bytes'] / a['bytes']):.1f}%** | {a['calls']}/{b['calls']} | {a['seconds']:.2f}/{b['seconds']:.2f} s | {a['correct']}/{a['questions']} · {b['correct']}/{b['questions']} | {b['recalls']} |")
    print("\n| 模型 / 图片 | 首图 原/裁 | 文本轮 原/裁 | 复看轮 原/裁 | 总 token 原/裁 |")
    print("|---|---:|---:|---:|---:|")
    for a, b, a_total, b_total in pairs:
        columns = []
        for a_round, b_round in zip(a["rounds"], b["rounds"]):
            a_size = sum(request["jsonBytes"] for request in a_round["requests"])
            b_size = sum(request["jsonBytes"] for request in b_round["requests"])
            columns.append(f"{size_str(a_size)} / {size_str(b_size)}")
        print(f"| {model_label(a)} / {a['fixture']} | {' | '.join(columns)} | {a_total['tokens']:,} / {b_total['tokens']:,} |")
    codex_pairs = [(a, b) for a, b, _, _ in pairs if a.get("transport") == "sse"]
    if codex_pairs:
        print("\n| Codex SSE 压缩体积（相同 zstd 算法） | 原版 | 裁剪后 | 减少 |")
        print("|---|---:|---:|---:|")
        for a, b in codex_pairs:
            original = [request.get("codexZstdBytes") for round_ in a["rounds"] for request in round_["requests"]]
            trimmed = [request.get("codexZstdBytes") for round_ in b["rounds"] for request in round_["requests"]]
            if any(value is None for value in original + trimmed):
                continue
            print(f"| {model_label(a)} / {a['fixture']} | {size_str(sum(original))} | {size_str(sum(trimmed))} | **{100 * (1 - sum(trimmed) / sum(original)):.1f}%** |")
    if native:
        print("\n| Codex 原生 auto 传输 | 题数 | WebSocket 全量请求 | WebSocket 增量请求 | SSE 回退次数 |")
        print("|---|---:|---:|---:|---:|")
        for trial in native:
            metrics = total(trial)
            stats = trial.get("websocket", {})
            print(f"| {model_label(trial)} / {trial['fixture']} | {metrics['correct']}/{metrics['questions']} | {stats.get('fullContextRequests', '未记录')} | {stats.get('deltaRequests', '未记录')} | {stats.get('sseFallbacks', '未记录')} |")


if __name__ == "__main__":
    main()
