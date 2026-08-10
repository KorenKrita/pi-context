#!/usr/bin/env python3
"""Lossless-render a Pi session JSONL into a sequential transcript plus a manifest.

The transcript keeps ALL text content in full; only JSON wrapping and base64
images are stripped. The manifest carries the structural facts the review
prompt uses to force full-coverage reading (entry count, first/last IDs,
every BRANCH_SUMMARY and LABEL id) and the facts the runner uses for
selection (whether the ACM extension was actually active) and for chunking
(byte size, part boundaries).

Usage:
  render.py <session.jsonl> <outdir> [--max-bytes N] [--probe]

Outputs in <outdir>:
  transcript.txt            (single part)  OR  part-01.txt, part-02.txt, ...
  manifest.json

--probe writes no transcript; it prints the manifest to stdout so a
selection script can cheaply decide whether the session is reviewable.
"""
import json
import os
import re
import sys

GAUGE_RE = re.compile(r"\[ctx \d+% (?:budget\(|window)")


def content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if not isinstance(p, dict):
                continue
            t = p.get("type")
            if t == "text":
                parts.append(p.get("text", ""))
            elif t == "thinking":
                parts.append(f"[thinking]\n{p.get('thinking', p.get('text', ''))}")
            elif t == "toolCall":
                args = json.dumps(p.get("arguments", {}), ensure_ascii=False)
                parts.append(f"[TOOL CALL] {p.get('name')}({args})")
            elif t == "image":
                parts.append("[image omitted]")
        return "\n".join(parts)
    return ""


def collect_tool_call_names(content):
    names = []
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict) and p.get("type") == "toolCall":
                names.append(p.get("name") or "")
    return names


def render(src):
    """Return (blocks, manifest). Each block is (entry_id, text)."""
    blocks = []
    branch_summaries = []
    labels = []
    acm_tool_calls = 0
    gauge_lines = 0
    user_messages = 0
    with open(src) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            et = e.get("type")
            eid = e.get("id", "?")
            text = None
            if et == "message":
                m = e.get("message", {})
                role = m.get("role", "?")
                if role == "toolResult":
                    body = content_to_text(m.get("content", []))
                    gauge_lines += len(GAUGE_RE.findall(body))
                    text = f"===== [{eid}] TOOL RESULT ({m.get('toolName', '?')}) =====\n{body}"
                elif role == "bashExecution":
                    text = f"===== [{eid}] BASH =====\n{m.get('command', '')}\n--- output ---\n{m.get('output', '')}"
                else:
                    if role == "user":
                        user_messages += 1
                    body = content_to_text(m.get("content", []))
                    for name in collect_tool_call_names(m.get("content", [])):
                        if name.startswith("acm_"):
                            acm_tool_calls += 1
                    text = f"===== [{eid}] {role.upper()} =====\n{body}"
            elif et in ("branch_summary", "compaction"):
                if et == "branch_summary":
                    branch_summaries.append(eid)
                text = f"===== [{eid}] {et.upper()} (context replaced from here) =====\n{e.get('summary', '')}"
            elif et == "label":
                labels.append({"id": eid, "label": e.get("label")})
                text = f"===== [{eid}] CHECKPOINT LABEL: {e.get('label')} ====="
            elif et == "custom_message":
                body = content_to_text(e.get("content", []))
                text = f"===== [{eid}] CUSTOM ({e.get('customType', '?')}) =====\n{body}"
            else:
                continue
            blocks.append((eid, text))
    total_bytes = sum(len(t.encode("utf-8")) + 2 for _, t in blocks)
    manifest = {
        "source": os.path.abspath(src),
        "entries": len(blocks),
        "first_id": blocks[0][0] if blocks else None,
        "last_id": blocks[-1][0] if blocks else None,
        "user_messages": user_messages,
        "branch_summaries": branch_summaries,
        "labels": labels,
        "acm_tool_calls": acm_tool_calls,
        "gauge_lines": gauge_lines,
        # Reviewable = the ACM extension demonstrably ran in this session.
        # A session with neither gauge lines nor acm_* calls produces a memo
        # about guidance nobody received (the memo6 failure).
        "acm_active": acm_tool_calls > 0 or gauge_lines > 0,
        "bytes": total_bytes,
    }
    return blocks, manifest


def split_parts(blocks, max_bytes):
    """Split blocks into parts of at most max_bytes each, on entry boundaries."""
    parts = []
    cur, cur_bytes = [], 0
    for eid, text in blocks:
        b = len(text.encode("utf-8")) + 2
        if cur and cur_bytes + b > max_bytes:
            parts.append(cur)
            cur, cur_bytes = [], 0
        cur.append((eid, text))
        cur_bytes += b
    if cur:
        parts.append(cur)
    return parts


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    probe = "--probe" in sys.argv
    max_bytes = 1_500_000
    if "--max-bytes" in sys.argv:
        max_bytes = int(sys.argv[sys.argv.index("--max-bytes") + 1])
        args = [a for a in args if a != str(max_bytes)]
    if not args or (not probe and len(args) < 2):
        sys.exit(__doc__)
    src = args[0]
    blocks, manifest = render(src)

    if probe:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return

    outdir = args[1]
    os.makedirs(outdir, exist_ok=True)
    parts = split_parts(blocks, max_bytes)
    manifest["parts"] = []
    if len(parts) == 1:
        path = os.path.join(outdir, "transcript.txt")
        with open(path, "w") as f:
            f.write("\n\n".join(t for _, t in parts[0]))
        manifest["parts"].append({
            "file": "transcript.txt", "entries": len(parts[0]),
            "first_id": parts[0][0][0], "last_id": parts[0][-1][0],
        })
    else:
        for i, part in enumerate(parts, 1):
            name = f"part-{i:02d}.txt"
            with open(os.path.join(outdir, name), "w") as f:
                f.write("\n\n".join(t for _, t in part))
            manifest["parts"].append({
                "file": name, "entries": len(part),
                "first_id": part[0][0], "last_id": part[-1][0],
            })
    with open(os.path.join(outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"{src}: {manifest['entries']} entries, {manifest['bytes']} bytes, "
          f"{len(parts)} part(s), acm_active={manifest['acm_active']} -> {outdir}")


if __name__ == "__main__":
    main()
