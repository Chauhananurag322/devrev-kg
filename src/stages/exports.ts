// Stage: exports
//
// For each Pkg, syntactically read its <root>/<sourceRoot relative>/index.ts(x)
// and extract the public export surface. Used by Phase 2 to populate per-package
// manifests; later by Phase 3 to seed the symbols table.
//
// CRITICAL: NO type checker, NO ts.Program. Only ts.createSourceFile per file.
//   - 948 packages * type-checker overhead = minutes
//   - 948 packages * createSourceFile per file = ~5-10 seconds
//
// Two patterns dominate (probed against devrev-web on 2026-05-26):
//
//   export * from './foo';                       // "barrel" wildcard re-export
//   export { X, Y as Z } from './bar';           // named re-export
//   export const/function/class/interface/...    // direct local definition
//   export default ...                            // default export (rare in this repo)
//
// Wildcards are recorded as a single PublicExport with kind='reexport-star' and
// name=specifier (e.g. './foo'). We do NOT recurse into the target file here —
// Phase 3's full AST walk handles that. Phase 2's manifest just needs to know
// "this package re-exports everything from ./foo".

import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import type { Config, Pkg, PublicExport } from "../types.js";
import { phase } from "../log.js";

interface ExportResult {
  pkg: string;
  // Repo-relative paths of every entry file we parsed for this package.
  // Empty array means we found nothing — neither an index.ts(x) nor a
  // package.json with `exports`. (Real for ~3% of libs in devrev-web.)
  entryFiles: string[];
  exports: PublicExport[];
}

// Resolve all entry files for a package. Two patterns:
//
//   1. Classic barrel: <sourceRoot>/index.ts(x). Returns one entry.
//   2. package.json `exports` map (modern multi-entry-point pattern):
//      { "./foo": "./src/foo.ts", "./bar": "./src/bar/index.ts", ... }
//      Returns each mapped target file, skipping conditional exports
//      (those with sub-objects like `{ "import": ..., "types": ... }`).
//
// devrev-web mixes both; ~32 of 948 libs use only #2 (the
// migrating-to-package-json-exports skill is actively migrating to it).
async function findEntryFiles(targetRepo: string, pkg: Pkg): Promise<string[]> {
  // 1) Classic index.ts(x) wins if present — it's the canonical public surface.
  const candidates = ["index.ts", "index.tsx", "index.mts", "index.cts"];
  for (const c of candidates) {
    const rel = join(pkg.sourceRoot, c);
    const abs = join(targetRepo, rel);
    const s = await stat(abs).catch(() => null);
    if (s?.isFile()) return [rel];
  }

  // 2) Fall back to package.json exports.
  const pkgJsonAbs = join(targetRepo, pkg.root, "package.json");
  const pkgJsonRaw = await readFile(pkgJsonAbs, "utf8").catch(() => null);
  if (!pkgJsonRaw) return [];
  let pkgJson: { exports?: Record<string, unknown> };
  try {
    pkgJson = JSON.parse(pkgJsonRaw);
  } catch {
    return [];
  }
  const exportsMap = pkgJson.exports;
  if (!exportsMap || typeof exportsMap !== "object") return [];

  const entries: string[] = [];
  for (const target of Object.values(exportsMap)) {
    // Conditional exports (e.g. { import, types, default }) are an object —
    // we'd need a richer resolver to handle them. devrev-web's exports maps
    // are all flat string targets, so we skip non-strings defensively.
    if (typeof target !== "string") continue;
    // target is relative to package root, e.g. "./src/foo.ts".
    // Convert to repo-relative: <pkg.root>/<target without leading "./">.
    const stripped = target.startsWith("./") ? target.slice(2) : target;
    const rel = join(pkg.root, stripped);
    const s = await stat(join(targetRepo, rel)).catch(() => null);
    if (s?.isFile()) entries.push(rel);
  }
  return entries;
}

// Extract a list of named exports from `export { X, Y as Z } from '...'` clauses
// or `export { X, Y }`. Each NamedExport has a `name` (the exported name, after
// any `as`) and an optional `propertyName` we don't care about for the manifest.
function collectNamedExports(
  node: ts.NamedExports,
  isType: boolean,
  sourceFile: string | undefined,
): PublicExport[] {
  return node.elements.map(
    (el) =>
      ({
        name: el.name.text,
        kind: "reexport",
        isType: isType || (el.isTypeOnly ?? false),
        ...(sourceFile ? { sourceFile } : {}),
      }) as PublicExport,
  );
}

// Walk the top-level statements of an index.ts(x). We don't recurse into nested
// blocks because nothing exports from inside a function/namespace at module top
// level in this repo's barrel files.
function extractFromSourceFile(
  sf: ts.SourceFile,
  indexFileRel: string,
): PublicExport[] {
  const out: PublicExport[] = [];

  for (const stmt of sf.statements) {
    // Case 1: `export * from './foo'` — wildcard re-export.
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.exportClause &&
      stmt.moduleSpecifier
    ) {
      // moduleSpecifier is a StringLiteral; its `.text` is the spec without quotes.
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      out.push({
        name: spec,
        kind: "reexport-star",
        isType: stmt.isTypeOnly,
        sourceFile: indexFileRel,
      });
      continue;
    }

    // Case 2: `export { X, Y as Z } from './bar'` OR `export { X, Y }`.
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const sourceSpec = stmt.moduleSpecifier
        ? (stmt.moduleSpecifier as ts.StringLiteral).text
        : indexFileRel; // local re-export — symbol must be defined in same file
      out.push(
        ...collectNamedExports(stmt.exportClause, stmt.isTypeOnly, sourceSpec),
      );
      continue;
    }

    // Case 3: direct declaration with `export` modifier.
    // covers: export function/class/interface/type/enum/const X
    const modifiers = ts.canHaveModifiers(stmt)
      ? ts.getModifiers(stmt)
      : undefined;
    const isExported = modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    const isDefault = modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
    );
    if (!isExported) continue;

    // Default exports — name often unavailable at this layer; record as 'default'.
    if (isDefault) {
      // Try to recover a name when the AST has one (e.g. `export default function Foo() {}`).
      let recoveredName = "default";
      if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        stmt.name
      ) {
        recoveredName = stmt.name.text;
      }
      out.push({
        name: recoveredName,
        kind: "default",
        isType: false,
        sourceFile: indexFileRel,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "function",
        isType: false,
        sourceFile: indexFileRel,
      });
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "class",
        isType: false,
        sourceFile: indexFileRel,
      });
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt)) {
      out.push({
        name: stmt.name.text,
        kind: "interface",
        isType: true,
        sourceFile: indexFileRel,
      });
      continue;
    }
    if (ts.isTypeAliasDeclaration(stmt)) {
      out.push({
        name: stmt.name.text,
        kind: "type",
        isType: true,
        sourceFile: indexFileRel,
      });
      continue;
    }
    if (ts.isEnumDeclaration(stmt)) {
      out.push({
        name: stmt.name.text,
        kind: "enum",
        isType: false,
        sourceFile: indexFileRel,
      });
      continue;
    }
    // export const X = ..., export const X = ..., Y = ... (multi-declarator)
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          out.push({
            name: decl.name.text,
            kind: "const",
            isType: false,
            sourceFile: indexFileRel,
          });
        }
        // Destructuring patterns at module top level are extremely rare in barrels;
        // we skip them rather than guess names from the destructure shape.
      }
      continue;
    }
  }

  return out;
}

async function extractOne(targetRepo: string, pkg: Pkg): Promise<ExportResult> {
  const entryRels = await findEntryFiles(targetRepo, pkg);
  if (entryRels.length === 0) {
    return { pkg: pkg.name, entryFiles: [], exports: [] };
  }

  // Parse each entry file syntactically. Files in package.json exports maps
  // are siblings of each other, not chained re-exports — every file is parsed
  // and its own top-level exports are collected.
  const allExports: PublicExport[] = [];
  for (const entryRel of entryRels) {
    const abs = join(targetRepo, entryRel);
    const src = await readFile(abs, "utf8");
    const scriptKind = entryRel.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
    // setParentNodes=false: we don't need parent traversal, slight memory + time win.
    const sf = ts.createSourceFile(
      abs,
      src,
      ts.ScriptTarget.ES2022,
      /*setParentNodes*/ false,
      scriptKind,
    );
    allExports.push(...extractFromSourceFile(sf, relative(targetRepo, abs)));
  }
  return { pkg: pkg.name, entryFiles: entryRels, exports: allExports };
}

export async function loadExports(
  config: Config,
  pkgs: Pkg[],
): Promise<Map<string, ExportResult>> {
  const p = phase("exports");

  // Concurrency: cap parallel readFile + parse to avoid spiking FD count on 948 pkgs.
  // 32 is well under macOS's default 256 FD soft limit and keeps disk queue healthy.
  const CONCURRENCY = 32;
  const queue = pkgs.slice();
  const results = new Map<string, ExportResult>();
  let withEntries = 0;
  let appsNoEntries = 0; // apps without an exported API surface — expected
  let libsNoEntries = 0; // libs without an entry — surprising, worth noting
  let multiEntry = 0;
  let totalExports = 0;
  let totalEntryFiles = 0;

  async function worker(): Promise<void> {
    while (queue.length) {
      const pkg = queue.shift();
      if (!pkg) return;
      const r = await extractOne(config.targetRepo, pkg);
      results.set(pkg.name, r);
      if (r.entryFiles.length === 0) {
        // Apps are terminal nodes; they don't export to other packages.
        // Only flag libs as a real "missing" case.
        if (pkg.kind === "app") appsNoEntries++;
        else libsNoEntries++;
      } else {
        withEntries++;
        if (r.entryFiles.length > 1) multiEntry++;
        totalEntryFiles += r.entryFiles.length;
      }
      totalExports += r.exports.length;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  p.end({
    pkgs_parsed: withEntries,
    apps_no_api: appsNoEntries,
    libs_no_entry: libsNoEntries,
    multi_entry_pkgs: multiEntry,
    total_entry_files: totalEntryFiles,
    total_exports: totalExports,
  });
  return results;
}
