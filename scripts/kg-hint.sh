#!/usr/bin/env bash
# Per-prompt KG routing reminder for Claude Code.
#
# Installed as a UserPromptSubmit hook by scripts/wire.mjs. Whatever this
# prints on stdout is appended to the model's context for THAT prompt — which
# is the point: SessionStart fires once, so by turn ~5 the repo-map's routing
# table is tens of thousands of tokens up-context and gets ignored in favour of
# habitual Grep/Glob. This re-states the routing rule at every turn.
#
# Deliberately tiny (~50 tokens). It runs on every single prompt, so cost here
# is paid over and over — it points at the tools rather than restating them.
#
# KG_DIR is passed as $1, baked in at wire time. That keeps this dependency-free
# (no jq, no config parsing, no node startup) so it adds no perceptible latency.
#
# Always exits 0 and never writes to stderr on the happy path — a hook that
# fails loudly on every prompt is worse than no hook at all.

set -u

KG_DIR="${1:-}"

# No KG_DIR, or the index was never built: stay silent rather than nagging on
# every prompt. maybe-rebuild.sh (SessionStart) is what fixes a missing index.
[ -n "$KG_DIR" ] || exit 0
[ -f "$KG_DIR/always/repo-map.md" ] || exit 0

cat <<'EOF'
<kg-reminder>
This repo is pre-indexed by the `kg` MCP server. For any question about where
code lives, what exists, or what depends on what, prefer the KG over filesystem
search: find_symbol / search_code / list_packages / get_package / who_imports /
get_dependency_path / find_skill (all prefixed `mcp__kg__`). Read the specific
files it points at. Grep/Glob remain right for string literals, config, and
non-code files.
</kg-reminder>
EOF

exit 0
