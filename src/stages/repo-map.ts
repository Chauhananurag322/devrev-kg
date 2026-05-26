// Stage: repo-map
//
// Assembles a single markdown file that gets injected into every Claude Code
// session via the SessionStart hook. Goal: pre-load enough context that
// "what apps exist?" / "where does X live?" answers without any tool calls.
//
// Size on devrev-web: ~33 KB (~6,200 tokens, ~3% of a 200k context window).
// 948 packages grouped by `libs/<top-dir>` with up to PER_GROUP_CAP packages
// shown per group. Sized for browsability — most domain groups (6-15 pkgs)
// fit fully inline, so common "what's in domain X?" questions answer from
// the injected map without any MCP call. Trim later if real usage shows
// the cost outweighs the benefit.
//
// Sections (in order):
//   1. Header (built timestamp + short git sha)
//   2. Stack one-liner with counts
//   3. Apps table (all 11)
//   4. Libs by domain (grouped, capped at 8 per group)
//   5. CLAUDE.md files (all 12)
//   6. Skills (all 12, descriptions truncated)
//   7. Rules (all 19)
//   8. Querying further (MCP tools available in current phase)

import type { BuildContext, CuratedDoc, Pkg } from "../types.js";
import { writeFileAtomic } from "../util/fs-atomic.js";
import { gitShaShort } from "../util/git.js";
import { phase as logPhase } from "../log.js";
import { groupOf } from "../writers/json.js";

// Cap on packages listed per lib-group. Above this, we collapse to "+ N more".
// 8 chosen for browsability: most domain groups in devrev-web are 6-15 packages,
// so 8 captures the majority of each domain inline. Ships ~6,200 tokens of
// always-injected context — about 3% of a 200k context window. Trim later if
// real usage shows the cost outweighs the lookup-without-MCP benefit.
const PER_GROUP_CAP = 8;

// Cap on skill description length. Some descriptions are 1k+ chars (e.g. playwright-test-writer);
// at full length they'd dominate the file.
const SKILL_DESC_CAP = 120;

// Cap on rule description length (most are <60 chars; this is just a safety net).
const RULE_DESC_CAP = 100;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

// ---- Section builders --------------------------------------------------

function renderHeader(builtAt: string, gitShaShort: string): string {
  return `# devrev-web — repo map\n\n_Built ${builtAt} · sha ${gitShaShort}_\n`;
}

function renderStack(pkgs: Pkg[]): string {
  const apps = pkgs.filter((p) => p.kind === "app").length;
  const libs = pkgs.filter((p) => p.kind === "lib").length;
  return [
    `## Stack`,
    ``,
    `Nx monorepo · pnpm · Node 22 · TypeScript · React`,
    `${apps} apps · ${libs} libs · ${pkgs.length} packages total`,
    ``,
  ].join("\n");
}

function renderApps(pkgs: Pkg[]): string {
  const apps = pkgs
    .filter((p) => p.kind === "app")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (apps.length === 0) return "";

  const lines = [
    `## Apps (${apps.length})`,
    ``,
    `| name | tags | root |`,
    `|---|---|---|`,
  ];
  for (const a of apps) {
    const tags = a.tags.length > 0 ? a.tags.join(", ") : "—";
    lines.push(`| \`${a.name}\` | ${tags} | \`${a.root}\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderLibs(pkgs: Pkg[]): string {
  const libs = pkgs.filter((p) => p.kind === "lib");
  // Group by libs/<top-dir>. Map preserves insertion order; we sort groups alphabetically below.
  const groups = new Map<string, Pkg[]>();
  for (const lib of libs) {
    const g = groupOf(lib);
    // Only show groups that come from libs/. Anything else (_apps, _tools) is
    // already in the apps table or is filtered. Defensive: skip non-lib groups
    // even though we already filtered to kind === 'lib'.
    if (g.startsWith("_")) continue;
    const arr = groups.get(g) ?? [];
    arr.push(lib);
    groups.set(g, arr);
  }

  const sortedGroupNames = [...groups.keys()].sort();
  const lines = [
    `## Libs by domain (${libs.length} across ${sortedGroupNames.length} groups)`,
    "",
    `Grouped by \`libs/<top-dir>\`. Each group lists up to ${PER_GROUP_CAP} packages alphabetically; rest queryable via MCP.`,
    "",
  ];

  for (const g of sortedGroupNames) {
    const members = (groups.get(g) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    lines.push(`### ${g} (${members.length})`);
    lines.push("");
    const shown = members.slice(0, PER_GROUP_CAP);
    for (const m of shown) {
      lines.push(`- \`${m.name}\``);
    }
    if (members.length > PER_GROUP_CAP) {
      const more = members.length - PER_GROUP_CAP;
      lines.push(
        `- _+ ${more} more — query via_ \`mcp__kg__list_packages({ glob: "${g}/*" })\``,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderClaudeMds(docs: CuratedDoc[]): string {
  const items = docs.filter((d) => d.kind === "claude_md");
  if (items.length === 0) return "";
  const lines = [
    `## CLAUDE.md files (${items.length})`,
    "",
    "Per-area context Claude should consult on demand:",
    "",
  ];
  // Stable order: by path.
  items.sort((a, b) => a.path.localeCompare(b.path));
  for (const d of items) {
    lines.push(`- \`${d.path}\` — ${d.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSkills(docs: CuratedDoc[]): string {
  const items = docs.filter((d) => d.kind === "skill");
  if (items.length === 0) return "";
  const lines = [
    `## Skills (${items.length})`,
    "",
    "Self-contained capabilities — invoke when their domain comes up:",
    "",
  ];
  items.sort((a, b) => a.title.localeCompare(b.title));
  for (const d of items) {
    const desc = d.description
      ? " — " + truncate(d.description, SKILL_DESC_CAP)
      : "";
    lines.push(`- **${d.title}**${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderRules(docs: CuratedDoc[]): string {
  const items = docs.filter((d) => d.kind === "rule");
  if (items.length === 0) return "";
  const lines = [
    `## Rules (${items.length})`,
    "",
    "Repo-wide conventions enforced via review or lint:",
    "",
  ];
  items.sort((a, b) => a.title.localeCompare(b.title));
  for (const d of items) {
    const desc = d.description
      ? " — " + truncate(d.description, RULE_DESC_CAP)
      : "";
    lines.push(`- \`${d.title}\`${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Footer is phase-aware: only advertises tools that exist at this build's
// phase, so users don't try to call something that isn't wired up yet.
function renderFooter(phase: 1 | 2 | 3 | 4): string {
  const phase2 = [
    "get_package",
    "list_packages",
    "find_skill",
    "get_repo_overview",
  ];
  const phase3a = ["find_symbol", "search_code"];
  const phase3b = ["who_imports", "get_dependency_path"];

  let tools: string[] = [];
  if (phase >= 2) tools = tools.concat(phase2);
  if (phase >= 3) tools = tools.concat(phase3a);
  if (phase >= 4) tools = tools.concat(phase3b);
  // NOTE: phase 3a vs 3b is collapsed to >=3 here. The KG runner
  // tracks Phase 3a/3b internally as a single "phase: 3" value.

  const lines = [`## Querying further`, ""];
  if (tools.length === 0) {
    lines.push(
      "_The MCP server is not wired up yet (Phase 1 build). Read this map and use the standard tools (Read/Grep/Glob)._",
    );
  } else {
    lines.push("Available MCP tools (prefixed `mcp__kg__`):");
    lines.push("");
    for (const t of tools) lines.push(`- \`mcp__kg__${t}\``);
  }
  lines.push("");
  return lines.join("\n");
}

// ---- Public entry ------------------------------------------------------

export async function writeRepoMap(
  ctx: BuildContext,
  pkgs: Pkg[],
  docs: CuratedDoc[],
  phase: 1 | 2 | 3 | 4 = 1,
): Promise<{ bytes: number }> {
  const p = logPhase("repo-map");

  const sha = await gitShaShort(ctx.config.targetRepo);
  const builtAt = new Date(ctx.startedAt).toISOString();

  const sections = [
    renderHeader(builtAt, sha),
    renderStack(pkgs),
    renderApps(pkgs),
    renderLibs(pkgs),
    renderClaudeMds(docs),
    renderSkills(docs),
    renderRules(docs),
    renderFooter(phase),
  ].filter((s) => s.length > 0);

  // Sections already end with a blank line; join with '\n' to avoid doubled gaps.
  const md = sections.join("\n");
  await writeFileAtomic(ctx.outputs.repoMapPath, md);

  const bytes = Buffer.byteLength(md, "utf8");
  p.end({ bytes, kb: (bytes / 1024).toFixed(1) });
  return { bytes };
}
