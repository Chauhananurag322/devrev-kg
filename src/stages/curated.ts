// Stage: curated
//
// Scans targetRepo for three kinds of human-written documentation:
//
//   - **/CLAUDE.md            (12 files, no frontmatter, free-form markdown)
//   - .shared/rules/*.md      (19 files, frontmatter: scope/description/last_verified)
//   - .claude/skills/**/SKILL.md (12 files, frontmatter: name/description/triggers)
//
// Phase 1 uses the result to populate the "CLAUDE.md files", "Rules", and
// "Skills" sections of repo-map.md. Phase 3 will re-read the same files
// (with bodies this time) into the claude_docs SQLite table.
//
// We deliberately keep bodies OUT of the in-memory CuratedDoc — saves ~200 KB
// of markdown text that Phase 1 doesn't need. Phase 3 reads bodies fresh.
//
// Side effect: mutates Pkg.claudeMd on any package that owns a CLAUDE.md,
// so per-package manifests in Phase 2 don't have to re-derive ownership.

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, basename, sep } from "node:path";
import type { Config, Pkg, CuratedDoc } from "../types.js";
import { log, phase } from "../log.js";
import { globFiles } from "../util/glob-helpers.js";

// Minimal frontmatter parser. We only need three keys (name, description, triggers).
// Skips a real YAML lib to avoid the dependency — see the stage doc above.
//
// Accepts:
//   ---
//   name: foo
//   description: a one-line summary
//   triggers:
//     - "write a test"
//     - "another phrase"
//   ---
//
// Returns null if no leading `---` line is present (caller treats as no-frontmatter).
interface Frontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
}

function parseFrontmatter(text: string): Frontmatter | null {
  // Frontmatter must start at the very top of the file. Split on \n only —
  // \r\n is uncommon in this repo, but `.split(/\r?\n/)` would still work
  // here with no behavior change.
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  // Find the closing `---`. If there isn't one, treat the file as having
  // no frontmatter (defensive against truncated/malformed files).
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const fm: Frontmatter = {};
  let i = 1;
  while (i < endIdx) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    i++;

    // `key: value`. We don't support nested objects — none of our keys need them.
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? "";
    let value = (m[2] ?? "").trim();

    // List form: `key:` followed by `- "..."` lines until the next non-list line.
    if (value === "" && key === "triggers") {
      const list: string[] = [];
      while (i < endIdx) {
        const next = (lines[i] ?? "").trimEnd();
        const lm = /^\s*-\s+(.*)$/.exec(next);
        if (!lm) break;
        // Strip surrounding quotes if present (YAML allows both quoted and unquoted).
        let item = (lm[1] ?? "").trim();
        if (
          (item.startsWith('"') && item.endsWith('"')) ||
          (item.startsWith("'") && item.endsWith("'"))
        ) {
          item = item.slice(1, -1);
        }
        list.push(item);
        i++;
      }
      fm.triggers = list;
      continue;
    }

    // Strip surrounding quotes for scalar values too.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "name") fm.name = value;
    else if (key === "description") fm.description = value;
    // Other keys (scope, last_verified, etc.) are deliberately ignored.
  }
  return fm;
}

// Walk up from `startDir` toward repo root, looking for the nearest project.json.
// Returns the directory that contains it, or null if none found before repo root.
async function findEnclosingProjectRoot(
  startDir: string,
  repoRoot: string,
): Promise<string | null> {
  let dir = startDir;
  while (dir.startsWith(repoRoot) && dir !== repoRoot) {
    const candidate = join(dir, "project.json");
    const found = await stat(candidate).catch(() => null);
    if (found?.isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // safety: hit FS root
    dir = parent;
  }
  return null;
}

async function loadClaudeMds(
  config: Config,
  pkgs: Pkg[],
): Promise<CuratedDoc[]> {
  // Glob is relative to targetRepo. ALWAYS_IGNORE in glob-helpers already excludes
  // node_modules / dist / .git, so we don't need to add anything here.
  const paths = await globFiles({
    cwd: config.targetRepo,
    patterns: "**/CLAUDE.md",
  });

  // Build a quick lookup: Pkg.root -> Pkg, so we can attribute each CLAUDE.md
  // to the package whose root contains it.
  const byRoot = new Map<string, Pkg>();
  for (const p of pkgs) byRoot.set(p.root, p);

  const docs: CuratedDoc[] = [];
  for (const rel of paths) {
    const abs = join(config.targetRepo, rel);
    const enclosingAbs = await findEnclosingProjectRoot(
      dirname(abs),
      config.targetRepo,
    );
    let pkgName: string | undefined;
    let title: string;

    if (enclosingAbs) {
      // Convert absolute back to repo-relative for the Pkg.root lookup.
      const enclosingRel = relative(config.targetRepo, enclosingAbs);
      const owner = byRoot.get(enclosingRel);
      if (owner) {
        pkgName = owner.name;
        title = owner.name;
        // Mutate the Pkg so per-package manifests already have the path.
        owner.claudeMd = rel;
      } else {
        // project.json exists but no matching Nx node (e.g. some tools/* projects
        // are filtered as e2e or non-app/lib by nx-graph). Use the path.
        title = enclosingRel;
      }
    } else {
      // No enclosing project.json. Two cases:
      //   - rel === "CLAUDE.md"  -> the repo-root CLAUDE.md
      //   - rel === "libs/widgets/CLAUDE.md" or "tools/foo/CLAUDE.md" -> CLAUDE.md
      //     in a directory that's a parent of Nx projects but isn't itself one.
      // In the second case, use the directory path as the title; it's the most
      // useful label for the repo-map.
      title = rel === "CLAUDE.md" ? "<root>" : dirname(rel);
    }

    docs.push({
      kind: "claude_md",
      path: rel,
      ...(pkgName ? { pkg: pkgName } : {}),
      title,
    });
  }
  return docs;
}

async function loadRules(config: Config): Promise<CuratedDoc[]> {
  // .shared/rules/*.md — flat directory, no recursion needed.
  const paths = await globFiles({
    cwd: config.targetRepo,
    patterns: ".shared/rules/*.md",
  });

  const docs: CuratedDoc[] = [];
  for (const rel of paths) {
    const abs = join(config.targetRepo, rel);
    const text = await readFile(abs, "utf8");
    const fm = parseFrontmatter(text);
    // Title = filename stem (e.g. "no-default-exports.md" -> "no-default-exports").
    const stem = basename(rel, ".md");
    docs.push({
      kind: "rule",
      path: rel,
      title: stem,
      ...(fm?.description ? { description: fm.description } : {}),
    });
  }
  return docs;
}

async function loadSkills(config: Config): Promise<CuratedDoc[]> {
  // .claude/skills/<skill-name>/SKILL.md — recursive glob handles the variable depth.
  const paths = await globFiles({
    cwd: config.targetRepo,
    patterns: ".claude/skills/**/SKILL.md",
  });

  const docs: CuratedDoc[] = [];
  for (const rel of paths) {
    const abs = join(config.targetRepo, rel);
    const text = await readFile(abs, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      // SKILL.md without frontmatter is malformed by our convention.
      // Don't crash; log and use the directory name as a fallback title.
      log.warn(`curated: SKILL.md has no frontmatter: ${rel}`);
    }
    // Fallback title: parent directory name (e.g. ".../playwright-test-writer/SKILL.md" -> "playwright-test-writer").
    const parts = rel.split(sep);
    const dirName = parts[parts.length - 2] ?? "unknown-skill";
    const title = fm?.name ?? dirName;

    docs.push({
      kind: "skill",
      path: rel,
      title,
      ...(fm?.description ? { description: fm.description } : {}),
      ...(fm?.triggers && fm.triggers.length > 0
        ? { triggers: fm.triggers }
        : {}),
    });
  }
  return docs;
}

export async function loadCurated(
  config: Config,
  pkgs: Pkg[],
): Promise<CuratedDoc[]> {
  const p = phase("curated");

  // Run the three loaders in parallel — they touch disjoint paths.
  const [claudeMds, rules, skills] = await Promise.all([
    loadClaudeMds(config, pkgs),
    loadRules(config),
    loadSkills(config),
  ]);

  const all = [...claudeMds, ...rules, ...skills];
  p.end({
    claude_mds: claudeMds.length,
    rules: rules.length,
    skills: skills.length,
    total: all.length,
  });
  return all;
}
