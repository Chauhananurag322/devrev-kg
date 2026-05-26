// Shared interfaces for the entire project.
//
// This file is intentionally pure type definitions — no `import` statements,
// no runtime code. Anyone can `import type { Pkg } from './types.js'` without
// triggering side effects or module-load ordering issues.

// 1) Config — the parsed config.json. Used everywhere.
export interface Config {
  targetRepo: string; // absolute path to the devrev-web checkout
  outputDir: string; // absolute path; the $KG dir under ~/.claude/projects/...
  nxBin: string; // shell command to run nx, e.g. "pnpm nx" or "npx nx"
  concurrency: number; // worker pool size for Phase 3 AST walk
  tmpDir: string; // scratch dir (e.g. for `nx graph --file=...` output)
  excludeGlobs: string[]; // glob patterns to skip during AST walk (tests, stories, .d.ts)
}

// 2) Pkg — one Nx project (an "app" or a "lib"), normalized from `nx graph` output.
//    All later stages consume Pkg[].
//
// `name` and `dependsOn` use Nx project names (strings), not object refs, because:
//   - JSON-serializable (we write _index.json from this)
//   - no circular reference risk
//   - reverse lookups are O(1) via Map<name, Pkg>
export interface Pkg {
  name: string; // e.g. "work-vistas/feature/sprint-board"
  kind: "app" | "lib"; // e2e and external (npm:*) projects are filtered out before constructing Pkg
  root: string; // path relative to targetRepo, e.g. "libs/work-vistas/feature/sprint-board"
  sourceRoot: string; // e.g. "libs/work-vistas/feature/sprint-board/src"
  tags: string[]; // from project.json `tags` (e.g. ["feature", "scope:sprint"])
  dependsOn: string[]; // names of other Pkgs this depends on (intra-repo only)
  // Filled in by the curated stage AFTER nx-graph builds the base Pkg:
  claudeMd?: string; // path (relative to targetRepo) of this package's CLAUDE.md, if any
}

// 3) CuratedDoc — represents a CLAUDE.md / rule / skill file we've ingested.
//    Used by repo-map.ts and (later in Phase 3) by the claude_docs SQLite table.
//
// We DO NOT keep the body in this struct because:
//   - Phase 1's repo-map.md only needs path + title + description
//   - Phase 3 will re-read the body fresh into the DB
// Keeping bodies in memory wastes ~500 KB across 43 docs we don't use here.
export interface CuratedDoc {
  kind: "claude_md" | "rule" | "skill";
  path: string; // relative to targetRepo
  pkg?: string; // owning Pkg.name if attributable (only meaningful for claude_md)
  title: string; // skills: frontmatter `name`; rules: filename stem; claude_md: nearest project name
  description?: string; // skills/rules frontmatter `description`
  triggers?: string[]; // skills frontmatter `triggers` (optional)
}

// 4) PublicExport — one symbol exported from a package's public API surface.
//    Produced by stages/exports.ts via syntactic walk of <root>/src/index.ts(x).
//    Consumed by Phase 2 manifests and by `mcp__kg__get_package`.
//
// `kind` is inferred from the AST node type. Re-exported wildcards (export *
// from './foo') don't yield individual symbols here — they're recorded as a
// single 'reexport-star' entry whose `name` is the source specifier (e.g. './foo').
// Phase 3's full AST walk will expand those into concrete symbols later.
export interface PublicExport {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "const"
    | "reexport" // export { X } from './bar' — X is named
    | "reexport-star" // export * from './bar' — name = './bar'
    | "default"; // export default ...
  isType: boolean; // true for type-only re-exports / interfaces / type aliases
  sourceFile?: string; // relative path of the file inside the package that backs this export, when known
}

// 5) BuildContext — the bag passed through stages so they don't re-derive paths.
//    Built once at the top of `kg full` / `kg affected`.
export interface BuildContext {
  config: Config;
  outputs: {
    repoMapPath: string; // <outputDir>/always/repo-map.md
    packagesDir: string; // <outputDir>/packages
    indexJsonPath: string; // <outputDir>/packages/_index.json
    lastBuildJsonPath: string; // <outputDir>/last-build.json
    dbPath: string; // <outputDir>/db/kg.sqlite (used in Phase 3)
    dbTmpPath: string; // <outputDir>/db/kg.sqlite.new (atomic-rename source)
  };
  startedAt: number; // Date.now() at build start — used for durationMs
  gitSha: string; // current HEAD of targetRepo, snapshotted once
}

// 6) Manifest — one per-package file at <KG>/packages/<pkg-name>.json.
//    Read on demand by the MCP server's `get_package` tool. Self-contained:
//    the MCP server should never need to consult anything else to answer
//    a package detail query.
export interface Manifest {
  name: string;
  kind: "app" | "lib";
  root: string;
  sourceRoot: string;
  tags: string[];
  group: string; // top-level dir, mirrors IndexEntry
  alias?: string; // @devrev-web/... alias if package is reachable via tsconfig paths
  claudeMd?: string; // path to CLAUDE.md if this package owns one
  dependsOn: string[]; // names of intra-repo dependencies
  dependents: string[]; // names of intra-repo dependents (reverse edges)
  entryFiles: string[]; // index.ts(x) or package.json `exports` targets
  publicExports: PublicExport[]; // syntactic export surface from entryFiles
  fileCount: number; // total .ts/.tsx files (excluding excluded globs)
}

// 7) IndexEntry — one row in _index.json. Flat, fast to filter in MCP server memory.
export interface IndexEntry {
  name: string;
  kind: "app" | "lib";
  root: string;
  tags: string[];
  group: string; // top-level lib dir, e.g. "work-vistas" or "_apps"
  // pre-computed so MCP filtering is a flat string compare
}

// 9) DB row shapes — Phase 3 SQLite schema mirrors. All ids are assigned by
//    SQLite's INTEGER PRIMARY KEY auto-increment; callers leave them undefined
//    on insert and read them back from the inserted-rowid result.

export interface PkgRow {
  id?: number;
  name: string;
  kind: "app" | "lib";
  root: string;
  sourceRoot: string;
  tags: string[]; // serialized to JSON before INSERT
  alias?: string;
  claudeMd?: string;
}

export interface FileRow {
  id?: number;
  packageId: number;
  path: string; // repo-relative, forward slashes
  language: "ts" | "tsx";
  bytes: number;
  isIndexFile: boolean;
}

// SymbolKind is the disjoint set of kinds we emit from the AST walker.
// `default` covers `export default …`; we record its identifier name when the
// AST has one (e.g. `export default function Foo()`), else 'default'.
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "component" // const X = (props) => JSX | function X(...) returning JSX (heuristic)
  | "hook" // identifier starts with `use` and follows React Hook conventions
  | "default";

export interface SymbolRow {
  id?: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  isExported: boolean;
  isDefault: boolean;
  lineStart: number;
  lineEnd: number;
  signature?: string; // truncated to 500 chars before INSERT
  jsdoc?: string; // truncated to 500 chars before INSERT
}

// 10) ImportRow / PackageDepRow — Phase 3b SQLite tables.
//
// Imports come from the AST walker. We record one row per import statement
// (named, default, namespace, or side-effect). `resolvedPackageId` is filled
// after the walk by stages/resolve-imports.ts via the alias map; rows that
// couldn't be resolved (npm packages, broken paths) keep it null.
export interface ImportRow {
  id?: number;
  fileId: number;
  moduleSpecifier: string; // raw spec: "@devrev-web/...", "react", "./util"
  importedName: string | null; // null for side-effect imports
  isTypeOnly: boolean;
  resolvedFileId?: number | null; // populated for relative-spec resolution (later)
  resolvedPackageId?: number | null;
}

export interface PackageDepRow {
  fromPackageId: number;
  toPackageId: number;
  edgeCount: number;
}

// 11) LastBuild — written to last-build.json; read by `kg status`.
//    Counts will be 0 in earlier phases (no AST yet) — that's intentional, so the
//    `status` command can show what each phase actually produced.
export interface LastBuild {
  builtAt: string; // ISO 8601 timestamp
  gitSha: string;
  durationMs: number;
  packageCount: number;
  fileCount: number; // total source files indexed (0 in Phase 1)
  symbolCount: number; // 0 until Phase 3
  importCount: number; // 0 until Phase 3
  dbBytes: number; // 0 until Phase 3
  phase: 1 | 2 | 3 | 4; // which phase produced this build (helps debug "why no symbols?")
}
