#!/usr/bin/env python3
"""Run one qualitative ACM session review end to end.

Pipeline:
  1. render.py renders the session JSONL into transcript part(s) + manifest;
  2. sessions where the ACM extension never ran are refused (memo6 failure);
  3. single-part sessions get the full-transcript prompt; oversized sessions
     go through the part-notes pipeline (sequential part reads, then one
     synthesis step);
  4. every LLM call goes through `pi -p` with a clean environment
     (--no-session --no-extensions --no-skills) so the reviewer is not
     itself running ACM.

Usage:
  run-review.py <session.jsonl> <outdir> [--model M] [--max-bytes N] [--force]

Outputs in <outdir>:
  transcript.txt / part-NN.txt, manifest.json   (from render.py)
  notes-NN.md                                   (part pipeline only)
  memo.md                                       (the deliverable)

Exit codes: 0 ok, 2 session not reviewable (ACM inactive), 1 other errors.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_MODEL = os.environ.get("ACM_REVIEW_MODEL", "local-openai/deepseek-v4-flash")


def read(path):
    with open(path) as f:
        return f.read()


def fill(template, mapping):
    out = template
    for key, value in mapping.items():
        out = out.replace("{{" + key + "}}", str(value))
    return out


def run_pi(prompt, model):
    """Send prompt to a clean pi -p and return stdout. Raises on failure."""
    result = subprocess.run(
        ["pi", "-p", "--no-session", "--no-extensions", "--no-skills",
         "--model", model, "--thinking", "max"],
        input=prompt, capture_output=True, text=True, timeout=3600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pi -p failed (rc={result.returncode}): {result.stderr[-2000:]}")
    output = result.stdout.strip()
    if not output:
        raise RuntimeError("pi -p returned empty output")
    return output


def core_text():
    return read(os.path.join(REPO, "guidance", "CORE.md"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    model = DEFAULT_MODEL
    if "--model" in sys.argv:
        model = sys.argv[sys.argv.index("--model") + 1]
        args = [a for a in args if a != model]
    max_bytes = ["--max-bytes", str(1_500_000)]
    if "--max-bytes" in sys.argv:
        max_bytes = ["--max-bytes", sys.argv[sys.argv.index("--max-bytes") + 1]]
        args = [a for a in args if a != max_bytes[1]]
    if len(args) < 2:
        sys.exit(__doc__)
    src, outdir = args[0], args[1]

    subprocess.run(
        [sys.executable, os.path.join(HERE, "render.py"), src, outdir, *max_bytes],
        check=True,
    )
    manifest = json.loads(read(os.path.join(outdir, "manifest.json")))

    if not manifest["acm_active"] and not force:
        print(f"REFUSED: no gauge lines and no acm_* calls in {src} — the ACM "
              f"extension was not active; a memo would evaluate guidance nobody "
              f"received. Use --force to override.", file=sys.stderr)
        sys.exit(2)

    shared = {
        "ENTRIES": manifest["entries"],
        "FIRST_ID": manifest["first_id"],
        "LAST_ID": manifest["last_id"],
        "USER_MESSAGES": manifest["user_messages"],
        "BRANCH_SUMMARIES": json.dumps(manifest["branch_summaries"], ensure_ascii=False) or "[]",
        "LABELS": json.dumps(manifest["labels"], ensure_ascii=False) or "[]",
        "ACM_TOOL_CALLS": manifest["acm_tool_calls"],
        "CORE": core_text(),
    }
    parts = manifest["parts"]

    if len(parts) == 1:
        template = read(os.path.join(HERE, "prompt-template.md"))
        prompt = fill(template, {
            **shared,
            "TRANSCRIPT": read(os.path.join(outdir, parts[0]["file"])),
        })
        memo = run_pi(prompt, model)
    else:
        part_template = read(os.path.join(HERE, "prompt-template-part.md"))
        notes = []
        for i, part in enumerate(parts, 1):
            prompt = fill(part_template, {
                "PART_NO": i,
                "PART_TOTAL": len(parts),
                "PART_ENTRIES": part["entries"],
                "PART_FIRST_ID": part["first_id"],
                "PART_LAST_ID": part["last_id"],
                "PREVIOUS_NOTES": "\n\n".join(
                    f"--- 第 {j} 段笔记 ---\n{n}" for j, n in enumerate(notes, 1)
                ) or "(第 1 段,无前情)",
            }) 
            prompt += "\n\n=== 本段 TRANSCRIPT ===\n\n" + read(os.path.join(outdir, part["file"]))
            note = run_pi(prompt, model)
            notes.append(note)
            with open(os.path.join(outdir, f"notes-{i:02d}.md"), "w") as f:
                f.write(note)
            print(f"part {i}/{len(parts)} noted ({len(note)} chars)")
        synth_template = read(os.path.join(HERE, "prompt-template-synthesis.md"))
        prompt = fill(synth_template, {
            **shared,
            "PART_TOTAL": len(parts),
            "PART_NOTES": "\n\n".join(
                f"--- 第 {j} 段笔记 ---\n{n}" for j, n in enumerate(notes, 1)
            ),
        })
        memo = run_pi(prompt, model)

    memo_path = os.path.join(outdir, "memo.md")
    with open(memo_path, "w") as f:
        f.write(memo)
    print(f"memo -> {memo_path} ({len(memo)} chars)")


if __name__ == "__main__":
    main()
