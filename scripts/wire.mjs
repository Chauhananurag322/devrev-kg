#!/usr/bin/env node
// One-shot installer that registers devrev-kg with Claude Code for the
// configured target repo.
//
// Reads config.json (next to this script's parent dir, or $KG_CONFIG) and
// edits the *targetRepo*'s `.claude/settings.local.json` to add:
//   - hooks.SessionStart with two entries:
//       1. cat repo-map.md into every session's context
//       2. invoke maybe-rebuild.sh to refresh the index in the background
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

function findExistingGroup(sessionStart) {
  if (!Array.isArray(sessionStart)) return null;
  return (
    sessionStart.find(
      (group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((h) => h?.command === HOOK_COMMAND),
    ) ?? null
  );
}

function merge(current) {
  const next = { ...current };

  // hooks.SessionStart: ensure our group exists with both repo-map cat AND
  // the rebuild trigger. Idempotent against partial installs.
  const existing = current.hooks?.SessionStart ?? [];
  const group = findExistingGroup(existing);

  let sessionStart;
  if (!group) {
    sessionStart = [...existing, desiredHookGroup];
  } else {
    const rebuildPresent = group.hooks.some(
      (h) => h?.command === REBUILD_HOOK,
    );
    if (!rebuildPresent) {
      group.hooks.push({ type: "command", command: REBUILD_HOOK });
    }
    sessionStart = existing;
  }

  next.hooks = {
    ...(current.hooks ?? {}),
    SessionStart: sessionStart,
  };

  return next;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const current = readCurrent();
  const next = merge(current);
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

  console.error(`updated ${TARGET}`);
  console.error(
    `  permissions.allow: ${permsBefore} -> ${permsAfter} (preserved)`,
  );
  console.error(
    `  hooks.SessionStart entries: ${hookCountBefore} -> ${hookCountAfter}`,
  );
  console.error("");
  console.error(
    "Next steps:",
  );
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
