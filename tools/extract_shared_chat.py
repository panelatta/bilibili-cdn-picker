"""Extract public user messages and final answers from a saved ChatGPT share HTML.

Usage: python3 tools/extract_shared_chat.py input.html docs/sources
Only parses JSON data; never executes scripts embedded in the downloaded page.
"""
import hashlib
import json
import re
import sys
from pathlib import Path


def extract(html):
    marker = re.search(r"window\.__reactRouterContext\.streamController\.enqueue\(", html)
    if not marker:
        raise ValueError("Share payload not found; page format may have changed")
    payload, _ = json.JSONDecoder().raw_decode(html[marker.end():])
    values = json.loads(payload)
    key_index = values.index("mapping")
    conversation = next(v for v in values if isinstance(v, dict) and f"_{key_index}" in v)
    cache = {}

    def decode(index):
        if not isinstance(index, int):
            return index
        if index < 0:
            return None
        if index in cache:
            return cache[index]
        value = values[index]
        if isinstance(value, dict):
            out = cache[index] = {}
            for key, ref in value.items():
                out[str(decode(int(key[1:])))] = decode(ref)
            return out
        if isinstance(value, list):
            out = cache[index] = []
            out.extend(decode(ref) for ref in value)
            return out
        return value

    mapping = decode(conversation[f"_{key_index}"])
    current_key = values.index("current_node")
    current = decode(conversation[f"_{current_key}"])
    chain, seen = [], set()
    while current:
        if current in seen:
            raise ValueError("Cyclic message ancestry")
        seen.add(current)
        node = mapping[current]
        chain.append(node)
        current = node.get("parent")

    messages = []
    for node in reversed(chain):
        msg = node.get("message") or {}
        role = msg.get("author", {}).get("role")
        meta = msg.get("metadata", {})
        if meta.get("is_visually_hidden_from_conversation") or meta.get("is_user_system_message"):
            continue
        if role != "user" and not (role == "assistant" and msg.get("channel") == "final"):
            continue
        parts = msg.get("content", {}).get("parts", [])
        raw = "\n\n".join(p for p in parts if isinstance(p, str))
        if not raw.strip():
            continue
        text = raw
        for ref in meta.get("content_references", []):
            marker = ref.get("matched_text")
            if not marker or not marker.startswith(""):
                continue
            links = []
            for item in ref.get("items", []):
                for source in [item] + item.get("supporting_websites", []):
                    url = source.get("url", "")
                    if url.startswith(("https://", "http://")) and url not in [u for _, u in links]:
                        links.append((source.get("attribution") or source.get("title") or "来源", url))
            replacement = "（" + "、".join(f"[{label}]({url})" for label, url in links) + "）" if links else ref.get("alt") or ""
            text = text.replace(marker, replacement)
        text = re.sub(r"url([^]+)([^]+)", r"[\1](\2)", text)
        messages.append({"role": role, "text": text, "source_text": raw})
    return messages


if __name__ == "__main__":
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    messages = extract(source.read_text())
    output.mkdir(parents=True, exist_ok=True)
    url = "https://chatgpt.com/share/6acf432d-c9ac-83ec-82e4-b3eafbdb45c3"
    metadata = {"title": "新加坡 B站网页版卡顿解决方案", "source_url": url,
                "captured_date": "2026-10-14", "timezone": "Asia/Singapore",
                "html_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "message_count": len(messages), "messages": messages}
    (output / "shared-chat.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    lines = ["# 新加坡 B站网页版卡顿解决方案 原始对话存档", "",
             f"来源：[ChatGPT 分享页面]({url})。抓取日期：2026-10-14。", "",
             "保留当前分享分支的用户提问及助手最终回复，按顺序排列；不包含系统消息、内部推理、工具输出及过程播报。网页引用标记已转为可点击链接，原始文本另存于 JSON 的 source_text 字段。以下为历史对话原文，技术判断和版本信息不代表已经验证。", ""]
    turn = 0
    for msg in messages:
        if msg["role"] == "user":
            turn += 1
        label = "用户" if msg["role"] == "user" else "ChatGPT"
        lines.extend([f"## 第 {turn} 轮 {label}", "", msg["text"], ""])
    (output / "shared-chat.md").write_text("\n".join(lines))
    print(json.dumps({"messages": len(messages), "user_turns": turn,
                      "characters": sum(len(m["text"]) for m in messages)}, ensure_ascii=False))
