#!/usr/bin/env bash
# SessionEnd hook: append a compact record of the finished session to a journal,
# so the NEXT session can see what recent sessions were about without replaying
# a ~170k-token transcript.
#
# WHAT THIS IS NOT: a summarizer. A shell hook cannot distill a conversation —
# only a model can, and no model runs here. So this records only what is
# mechanically derivable and already trustworthy:
#
#   - `aiTitle`   — the session title Claude Code itself generated. This is the
#                   one genuinely summarized field available, written by the app.
#   - lastPrompt  — what the user asked most recently, i.e. where things landed.
#   - gitSha + dirty-file count for the target repo at session end.
#   - counts (turns, tools) as a cheap proxy for "was this a real work session".
#
# Durable conclusions still belong in memory/*.md, written deliberately by the
# agent. This journal is a breadcrumb trail — "you were here recently" — not a
# replacement for that. Conflating the two is how you end up recalling claims
# that were disproven later in the same session.
#
# Usage (installed by scripts/wire.mjs):
#   session-end.sh <KG_DIR> <TARGET_REPO>
#
# Always exits 0. A failing SessionEnd hook must never be visible to the user.

set -u

KG_DIR="${1:-}"
TARGET_REPO="${2:-}"

[ -n "$KG_DIR" ] || exit 0
[ -d "$KG_DIR" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

JOURNAL="$KG_DIR/sessions.jsonl"
# Keep the journal bounded. The repo-map reads only the most recent few entries,
# so unbounded growth buys nothing.
MAX_ENTRIES=50

# Claude Code passes hook input as JSON on stdin. We want session_id and
# transcript_path; both are best-effort — if stdin is empty we still record the
# git state, which is the part that can't be recovered later.
STDIN_JSON="$(cat 2>/dev/null || echo '{}')"

HEAD_SHA=""
DIRTY=""
if [ -n "$TARGET_REPO" ] && [ -d "$TARGET_REPO" ]; then
  HEAD_SHA="$(git -C "$TARGET_REPO" rev-parse --short HEAD 2>/dev/null || echo)"
  DIRTY="$(git -C "$TARGET_REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
fi

# Everything below is pure stdlib and cannot block. Python does the JSON work
# because jq is not guaranteed present and hand-rolling JSON escaping in bash is
# how you corrupt a journal.
#
# The hook payload goes in via ARGV, not stdin: stdin is already taken by the
# heredoc carrying this script, and two stdin redirections silently means the
# last one wins (which fed the payload in as the program text).
python3 - "$JOURNAL" "$MAX_ENTRIES" "$HEAD_SHA" "$DIRTY" "$STDIN_JSON" <<'PY' 2>/dev/null || exit 0
import json, os, sys, datetime

journal_path, max_entries, head_sha, dirty = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
payload = sys.argv[5] if len(sys.argv) > 5 else "{}"

try:
    hook = json.loads(payload or "{}")
except Exception:
    hook = {}

session_id = hook.get("session_id") or hook.get("sessionId") or ""
transcript = hook.get("transcript_path") or hook.get("transcriptPath") or ""
cwd = hook.get("cwd") or ""
reason = hook.get("reason") or ""

ai_title = ""
last_prompt = ""
turns = 0
tools = 0

# Read the transcript for the fields the app already computed for us. Streaming
# line-by-line: transcripts reach hundreds of KB and we want a few small fields.
if transcript and os.path.isfile(transcript):
    try:
        with open(transcript, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                t = entry.get("type")
                if t == "ai-title":
                    ai_title = entry.get("aiTitle") or ai_title
                elif t == "last-prompt":
                    last_prompt = entry.get("lastPrompt") or last_prompt
                elif t == "user":
                    turns += 1
                elif t == "assistant":
                    msg = entry.get("message") or {}
                    content = msg.get("content")
                    if isinstance(content, list):
                        tools += sum(1 for b in content
                                     if isinstance(b, dict) and b.get("type") == "tool_use")
    except Exception:
        pass

# Trim the prompt: we want a breadcrumb, not a paste. Long prompts are usually
# long because they contain pasted output, which is exactly the noise to drop.
last_prompt = " ".join(last_prompt.split())
if len(last_prompt) > 240:
    last_prompt = last_prompt[:239].rstrip() + "…"

entry = {
    "endedAt": datetime.datetime.now(datetime.timezone.utc)
                 .isoformat(timespec="seconds").replace("+00:00", "Z"),
    "sessionId": session_id,
    "cwd": cwd,
    "aiTitle": ai_title,
    "lastPrompt": last_prompt,
    "turns": turns,
    "toolCalls": tools,
    "gitSha": head_sha,
    "dirtyFiles": int(dirty) if dirty.isdigit() else None,
    "endReason": reason,
}

# Skip trivial sessions — a session with no real work would push out a useful
# entry and add noise to the next session's context.
if turns < 2 and not ai_title:
    sys.exit(0)

existing = []
if os.path.isfile(journal_path):
    try:
        with open(journal_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    existing.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        existing = []

# Same session appearing twice (resume, or a re-fired hook) replaces the earlier
# record rather than duplicating it.
if session_id:
    existing = [e for e in existing if e.get("sessionId") != session_id]

existing.append(entry)
existing = existing[-max_entries:]

# Atomic write: this file is read by SessionStart, so a torn write would land in
# the next session's context.
tmp = journal_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    for e in existing:
        fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    fh.flush()
    os.fsync(fh.fileno())
os.replace(tmp, journal_path)
PY

exit 0
