// Stage: resolve-imports (Phase 3b)
//
// Runs AFTER the AST walk. Two passes over the imports table:
//
//   1. For each import row, resolve `module_specifier` to a target package
//      using the precomputed AliasMap (O(1) per row). External packages
//      (react, lodash, etc.) and unresolvable relatives stay unresolved.
//   2. Aggregate resolved imports into package_deps (from_package_id,
//      to_package_id, edge_count). One row per (src,dst) pair, count = N
//      total import statements crossing that boundary.
//
// We do NOT use ts.resolveModuleName. The alias map is the entire mechanism;
// devrev-web's import shape (everything goes through @devrev-web/<...>) makes
// this complete coverage for cross-package edges.

import { join } from "node:path";
import type { PackageDepRow } from "../types.js";
import type { Db } from "../writers/sqlite.js";
import { bulkInsertPackageDeps } from "../writers/sqlite.js";
import type { AliasMap } from "../util/alias-map.js";
import { phase } from "../log.js";

export interface ResolveResult {
  resolvedImports: number;
  packageEdges: number;
}

export function resolveImports(
  db: Db,
  aliasMap: AliasMap,
  targetRepo: string,
): ResolveResult {
  const p = phase("resolve-imports");

  // Build alias-target -> packageId map. The alias map's reverse direction is
  // file -> alias; we need file -> packageId. Files are addressed by the same
  // path key (absolute path of the index file), so we look it up from the
  // packages table by source_root.
  // packages.source_root is repo-relative (e.g. "libs/foo/src"). The alias
  // target is absolute (e.g. "/Users/.../libs/foo/src/index.ts"). We invert:
  // for each (alias, absPath) pair, derive the package's source_root and
  // look up its id.
  const pkgsBySourceRoot = new Map<string, number>();
  const allPkgs = db
    .prepare(`SELECT id, source_root FROM packages`)
    .all() as Array<{ id: number; source_root: string }>;
  for (const p of allPkgs) pkgsBySourceRoot.set(p.source_root, p.id);

  // alias -> packageId
  const aliasToPkgId = new Map<string, number>();
  const targetRepoPrefix = targetRepo.endsWith("/")
    ? targetRepo
    : targetRepo + "/";
  for (const [alias, absPath] of aliasMap.aliasToFile) {
    if (!absPath.startsWith(targetRepoPrefix)) continue;
    const repoRel = absPath.slice(targetRepoPrefix.length);
    // Derive sourceRoot by stripping the trailing /index.{ts,tsx,...} or any file segment.
    // We accept any file under <sourceRoot>/* — go up one dir at a time looking for a known sourceRoot.
    let dir = dirOf(repoRel);
    while (dir.length > 0) {
      const pkgId = pkgsBySourceRoot.get(dir);
      if (pkgId !== undefined) {
        aliasToPkgId.set(alias, pkgId);
        break;
      }
      const next = dirOf(dir);
      if (next === dir) break;
      dir = next;
    }
  }

  // Update imports: set resolved_package_id where module_specifier matches an alias.
  // We do this in chunks to avoid excessive prepared-statement param ballooning.
  const update = db.prepare(
    `UPDATE imports SET resolved_package_id = ? WHERE module_specifier = ?`,
  );
  const updateMany = db.transaction((entries: Array<[string, number]>) => {
    for (const [spec, pkgId] of entries) update.run(pkgId, spec);
  });

  // Convert map to entries for the transaction.
  // Run only over aliases that we resolved to a packageId.
  const entries: Array<[string, number]> = [];
  for (const [alias, pkgId] of aliasToPkgId) entries.push([alias, pkgId]);
  updateMany(entries);

  // Count rows resolved.
  const resolvedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM imports WHERE resolved_package_id IS NOT NULL`,
    )
    .get() as { n: number };

  // Aggregate into package_deps. We compute per-(src,dst) pair counts from the
  // imports table by joining to files->packages.
  const aggRows = db
    .prepare(
      `SELECT f.package_id AS from_pkg, i.resolved_package_id AS to_pkg, COUNT(*) AS n
         FROM imports i
         JOIN files f ON f.id = i.file_id
        WHERE i.resolved_package_id IS NOT NULL
          AND i.resolved_package_id != f.package_id   -- skip self-loops
        GROUP BY f.package_id, i.resolved_package_id`,
    )
    .all() as Array<{ from_pkg: number; to_pkg: number; n: number }>;

  const depRows: PackageDepRow[] = aggRows.map((r) => ({
    fromPackageId: r.from_pkg,
    toPackageId: r.to_pkg,
    edgeCount: r.n,
  }));
  if (depRows.length > 0) bulkInsertPackageDeps(db, depRows);

  p.end({ resolved_imports: resolvedRow.n, package_edges: depRows.length });

  return { resolvedImports: resolvedRow.n, packageEdges: depRows.length };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// Re-exports to keep build.ts happy if it ever wants the join helper.
export function joinAbs(targetRepo: string, rel: string): string {
  return join(targetRepo, rel);
}
