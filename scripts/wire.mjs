#!/usr/bin/env node
// One-shot installer that registers devrev-kg with Claude Code for the
// configured target repo.
//
// Reads config.json (next to this script's parent dir, or $KG_CONFIG) and
// edits the *targetRepo*'s `.claude/settings.local.json` to add:
//   - hooks.SessionStart with two entries:
//       1. cat repo-map.md into every session's context
//       2. invoke maybe-rebuild.sh to refresh the index in the background
//   - hooks.UserPromptSubmit with one entry:
//       3. invoke kg-hint.sh to re-state the KG routing rule on every prompt
//
// Why both: SessionStart fires ONCE per session, so its guidance drifts far
// up-context and agents fall back to habitual Grep/Glob after a few turns.
// UserPromptSubmit fires on every prompt, keeping the routing rule in view.
// SessionStart carries the bulk payload (the map); UserPromptSubmit carries a
// ~50-token pointer, since its cost is paid on every single turn.
//
// MCP server registration is NOT done here — Claude Code's `claude mcp add`
// CLI is the supported path for that. See README.
//
// Idempotent: existing permissions and other top-level keys are preserved.
// Backs up the original to `.bak` on first run.
//
// Usage:
//   node scripts/wire.mjs            # apply
//   node scripts/wire.mjs --dry-run  # print resulting JSON, don't write

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = process.env.KG_CONFIG ?? join(REPO_ROOT, "config.json");

if (!existsSync(CONFIG_PATH)) {
  console.error(
    `wire: ${CONFIG_PATH} not found. Copy config.example.json to config.json and edit it first.`,
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const TARGET_REPO = config.targetRepo;
const KG_DIR = config.outputDir;
const TARGET = join(TARGET_REPO, ".claude", "settings.local.json");
const REBUILD_HOOK = join(REPO_ROOT, "scripts", "maybe-rebuild.sh");
// KG_DIR is baked in as an argument so the hint script stays dependency-free
// (no config parsing) — it runs on every prompt, so startup cost matters.
const HINT_HOOK = `${join(REPO_ROOT, "scripts", "kg-hint.sh")} ${KG_DIR}`;

if (!TARGET_REPO || !KG_DIR) {
  console.error("wire: config.json is missing targetRepo or outputDir");
  process.exit(1);
}

// The exact command string we install as a SessionStart hook. Used both for
// writing AND for idempotency check (identity = same command string).
const HOOK_COMMAND =
  `cat ${KG_DIR}/always/repo-map.md 2>/dev/null` +
  ` || echo '[KG not built yet — run: cd ${REPO_ROOT} && pnpm kg:full]'`;

const desiredHookGroup = {
  hooks: [
    { type: "command", command: HOOK_COMMAND },
    { type: "command", command: REBUILD_HOOK },
  ],
};

const desiredPromptHookGroup = {
  hooks: [{ type: "command", command: HINT_HOOK }],
};

// ---- Main --------------------------------------------------------------

function readCurrent() {
  if (!existsSync(TARGET)) return {};
  const raw = readFileSync(TARGET, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${TARGET} is not valid JSON. Fix it manually before re-running.\n  ${err.message}`,
    );
  }
}

// Does this group own any command matching `match`?
function groupMatches(group, match) {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => typeof h?.command === "string" && match(h.command))
  );
}

// Install exactly one canonical group of ours into `groups`, keyed by `match`.
//
// Matching is by PREDICATE, never string equality: our command strings embed
// absolute paths (KG_DIR, REPO_ROOT), and those legitimately change — an
// earlier install wrote `cd ~/Office/devrev-kg` where we now emit the resolved
// absolute path. Exact-match treated that as "not installed" and appended a
// second group, which silently injected the 40KB repo-map TWICE per session.
//
// So: drop every group of ours, then append one freshly-built group. That
// refreshes stale paths and self-heals any duplicates a previous run left
// behind. Groups we don't recognise are preserved untouched and in order.
function replaceGroup(groups, match, desired) {
  const existing = Array.isArray(groups) ? groups : [];
  const foreign = existing.filter((g) => !groupMatches(g, match));
  return {
    groups: [...foreign, desired],
    removed: existing.length - foreign.length,
  };
}

// Stable identities — the part of each command that does NOT vary with
// configured paths.
const isRepoMapHook = (c) => c.includes("always/repo-map.md");
const isHintHook = (c) => c.includes("kg-hint.sh");

function merge(current) {
  const next = { ...current };

  // SessionStart: cat the map + trigger a background rebuild. Rebuilt from
  // scratch so a re-wire after moving outputDir refreshes both commands.
  const session = replaceGroup(
    current.hooks?.SessionStart,
    isRepoMapHook,
    desiredHookGroup,
  );

  // UserPromptSubmit: the per-prompt routing reminder.
  const prompt = replaceGroup(
    current.hooks?.UserPromptSubmit,
    isHintHook,
    desiredPromptHookGroup,
  );

  next.hooks = {
    ...(current.hooks ?? {}),
    SessionStart: session.groups,
    UserPromptSubmit: prompt.groups,
  };

  return { next, replaced: session.removed + prompt.removed };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const current = readCurrent();
  const { next, replaced } = merge(current);
  const out = JSON.stringify(next, null, 2) + "\n";

  if (dryRun) {
    process.stdout.write(out);
    return;
  }

  if (existsSync(TARGET) && !existsSync(`${TARGET}.bak`)) {
    copyFileSync(TARGET, `${TARGET}.bak`);
    console.error(`backed up ${TARGET} -> ${TARGET}.bak`);
  }

  writeFileSync(TARGET, out);

  const permsBefore = current.permissions?.allow?.length ?? 0;
  const permsAfter = next.permissions?.allow?.length ?? 0;
  const hookCountBefore = current.hooks?.SessionStart?.length ?? 0;
  const hookCountAfter = next.hooks?.SessionStart?.length ?? 0;
  const promptBefore = current.hooks?.UserPromptSubmit?.length ?? 0;
  const promptAfter = next.hooks?.UserPromptSubmit?.length ?? 0;

  console.error(`updated ${TARGET}`);
  console.error(
    `  permissions.allow: ${permsBefore} -> ${permsAfter} (preserved)`,
  );
  console.error(
    `  hooks.SessionStart entries: ${hookCountBefore} -> ${hookCountAfter}`,
  );
  console.error(
    `  hooks.UserPromptSubmit entries: ${promptBefore} -> ${promptAfter}`,
  );
  if (replaced > 0) {
    console.error(
      `  replaced ${replaced} existing kg hook group(s) (stale paths / duplicates)`,
    );
  }
  console.error("");
  console.error("Next steps:");
  console.error(
    `  1. Register the MCP server (run from inside ${TARGET_REPO}):`,
  );
  console.error(
    `       claude mcp add kg --scope local --env KG_DIR=${KG_DIR} -- node ${join(REPO_ROOT, "dist/mcp/server.js")}`,
  );
  console.error("  2. Restart Claude Code to pick up the hooks + MCP server.");
}

try {
  main();
} catch (err) {
  console.error(`wire: ${err.message}`);
  process.exit(1);
}
