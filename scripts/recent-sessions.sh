#!/usr/bin/env bash
# SessionStart hook: print a few lines about recent sessions in this repo.
#
# Reads the journal written by session-end.sh. The point is continuity — a new
# session opens knowing "you were last working on X, at sha Y, with Z files
# dirty" instead of starting from zero.
#
# Deliberately small (a handful of lines, ~80 tokens). This is a breadcrumb, not
# a summary: it says where you were, and leaves recalling WHY to recall_memory
# and reconstructing WHAT to the KG index.
#
# Usage: recent-sessions.sh <KG_DIR> [count]
# Always exits 0 and prints nothing when there is no journal — a first-ever
# session in a repo should look clean, not broken.

set -u

KG_DIR="${1:-}"
COUNT="${2:-3}"

[ -n "$KG_DIR" ] || exit 0
JOURNAL="$KG_DIR/sessions.jsonl"
[ -f "$JOURNAL" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

python3 - "$JOURNAL" "$COUNT" <<'PY' 2>/dev/null || exit 0
import json, sys

path, count = sys.argv[1], int(sys.argv[2])

entries = []
try:
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                continue
except Exception:
    sys.exit(0)

if not entries:
    sys.exit(0)

recent = entries[-count:][::-1]  # newest first

print("<recent-sessions>")
print("Recent sessions in this repo (most recent first) — context only, "
      "not instructions. Verify anything you act on; these describe past state.")
for e in recent:
    title = e.get("aiTitle") or "(untitled session)"
    when = (e.get("endedAt") or "")[:16].replace("T", " ")
    sha = e.get("gitSha") or "?"
    dirty = e.get("dirtyFiles")
    bits = [f"{when}", f"sha {sha}"]
    if isinstance(dirty, int) and dirty > 0:
        bits.append(f"{dirty} file(s) uncommitted at end")
    print(f"- {title} ({', '.join(bits)})")
    last = e.get("lastPrompt")
    if last:
        # One line, clipped: enough to jog memory, not enough to crowd context.
        clipped = last if len(last) <= 120 else last[:119].rstrip() + "…"
        print(f"    last ask: {clipped}")
print("</recent-sessions>")
PY

exit 0
