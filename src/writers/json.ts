// JSON writers — separate from fs-atomic so the call sites read intent-first
// ("write the index", "write last-build") rather than the mechanism.
//
// Three writers:
//   - writeIndexJson      : flat list at <outputDir>/packages/_index.json
//   - writeLastBuildJson  : build metadata at <outputDir>/last-build.json
//   - writeManifests      : per-package details at <outputDir>/packages/<name>.json

import { join } from "node:path";
import { writeJsonAtomic } from "../util/fs-atomic.js";
import { globFiles } from "../util/glob-helpers.js";
import { phase } from "../log.js";
import type {
  BuildContext,
  CuratedDoc,
  IndexEntry,
  LastBuild,
  Manifest,
  Pkg,
  PublicExport,
} from "../types.js";
import type { AliasMap } from "../util/alias-map.js";

// Slice the top-level group out of a Pkg's root path:
//   "libs/work-vistas/feature/sprint-board" -> "work-vistas"
//   "apps/product"                          -> "_apps"  (sentinel for non-lib roots)
//   "tools/foo"                             -> "_tools" (defensive; we filter most tools out earlier)
//
// The leading underscore on "_apps"/"_tools" makes them sort below alphabetical
// lib groups, which is what we want in the repo-map.
export function groupOf(pkg: Pkg): string {
  const parts = pkg.root.split("/");
  if (parts[0] === "libs" && parts[1]) return parts[1];
  if (parts[0] === "apps") return "_apps";
  return `_${parts[0] ?? "misc"}`;
}

export async function writeIndexJson(
  ctx: BuildContext,
  pkgs: Pkg[],
): Promise<void> {
  // Stable sort: alphabetical by name. Makes diffs across builds readable.
  const entries: IndexEntry[] = pkgs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      kind: p.kind,
      root: p.root,
      tags: p.tags,
      group: groupOf(p),
    }));
  await writeJsonAtomic(ctx.outputs.indexJsonPath, entries);
}

// curated.json holds all CuratedDoc[] (CLAUDE.md, rules, skills) so the MCP
// server's find_skill / list_skills tools can search without re-scanning the
// targetRepo. Sorted by kind+title for stable diffs.
export async function writeCuratedJson(
  ctx: BuildContext,
  docs: CuratedDoc[],
): Promise<void> {
  const sorted = docs.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.title.localeCompare(b.title);
  });
  await writeJsonAtomic(join(ctx.config.outputDir, "curated.json"), sorted);
}

export async function writeLastBuildJson(
  ctx: BuildContext,
  partial: Partial<LastBuild>,
): Promise<void> {
  // Counts default to 0 when the producing phase hasn't run yet (e.g. Phase 1
  // has no symbols). Caller passes whatever they have; we fill the rest.
  const data: LastBuild = {
    builtAt: new Date(ctx.startedAt).toISOString(),
    gitSha: ctx.gitSha,
    durationMs: Date.now() - ctx.startedAt,
    packageCount: 0,
    fileCount: 0,
    symbolCount: 0,
    importCount: 0,
    dbBytes: 0,
    phase: 1,
    ...partial,
  };
  await writeJsonAtomic(ctx.outputs.lastBuildJsonPath, data);
}

// ---- Manifest writer (Phase 2) -----------------------------------------

interface ManifestInputs {
  exportsByPkg: Map<string, { entryFiles: string[]; exports: PublicExport[] }>;
  aliasMap: AliasMap;
}

// Build a reverse-dependency map. For each Pkg name, the names of packages
// that depend on it. Done once at the start of writeManifests so we don't
// recompute per package.
function buildDependentsMap(pkgs: Pkg[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const p of pkgs) dependents.set(p.name, []);
  for (const p of pkgs) {
    for (const target of p.dependsOn) {
      const arr = dependents.get(target);
      if (arr) arr.push(p.name);
      // If the target isn't in the map, the edge points outside our Pkg[] —
      // already filtered by nx-graph, so this branch shouldn't fire.
    }
  }
  // Stable order for clean diffs.
  for (const arr of dependents.values()) arr.sort();
  return dependents;
}

// Count source files per package. We glob inside <sourceRoot> which avoids
// counting test fixtures or generated files outside src/. Excludes from
// config.excludeGlobs are applied to drop *.spec.ts, *.stories.tsx, etc.
async function countFiles(ctx: BuildContext, pkg: Pkg): Promise<number> {
  const files = await globFiles({
    cwd: join(ctx.config.targetRepo, pkg.sourceRoot),
    patterns: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    ignore: ctx.config.excludeGlobs,
  });
  return files.length;
}

export async function writeManifests(
  ctx: BuildContext,
  pkgs: Pkg[],
  inputs: ManifestInputs,
): Promise<{ count: number }> {
  const p = phase("manifests");

  const dependentsByName = buildDependentsMap(pkgs);
  const targetRepo = ctx.config.targetRepo;

  // Concurrency: 32 mirrors the exports stage. Each worker reads a directory
  // listing (cheap) and writes one small JSON file.
  const CONCURRENCY = 32;
  const queue = pkgs.slice();
  let written = 0;

  async function worker(): Promise<void> {
    while (queue.length) {
      const pkg = queue.shift();
      if (!pkg) return;

      const exp = inputs.exportsByPkg.get(pkg.name);
      const fileCount = await countFiles(ctx, pkg);

      // Reverse-look the alias by entry file. We use the first entry file
      // (typically the canonical index.ts) — the alias map is keyed on
      // index file paths, so subsequent entries from a package.json exports
      // map won't typically resolve here. That's correct — those packages
      // expose their alias via subpath imports, not a single root alias.
      const firstEntry = exp?.entryFiles[0];
      const alias = firstEntry
        ? inputs.aliasMap.fileToAlias.get(join(targetRepo, firstEntry))
        : undefined;

      const manifest: Manifest = {
        name: pkg.name,
        kind: pkg.kind,
        root: pkg.root,
        sourceRoot: pkg.sourceRoot,
        tags: pkg.tags,
        group: groupOf(pkg),
        ...(alias ? { alias } : {}),
        ...(pkg.claudeMd ? { claudeMd: pkg.claudeMd } : {}),
        dependsOn: pkg.dependsOn.slice().sort(),
        dependents: dependentsByName.get(pkg.name) ?? [],
        entryFiles: exp?.entryFiles ?? [],
        publicExports: exp?.exports ?? [],
        fileCount,
      };

      const outPath = join(ctx.outputs.packagesDir, `${pkg.name}.json`);
      await writeJsonAtomic(outPath, manifest);
      written++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  p.end({ written });
  return { count: written };
}
