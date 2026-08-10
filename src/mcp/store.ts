// Read-only data store backing the MCP server.
//
// At server startup we load:
//   - _index.json   into memory (small, ~180 KB; flat array; filtered often)
//   - curated.json  into memory (small, ~30 KB; filtered for skills/rules/etc.)
//   - last-build.json into memory (~250 B; reported in tool responses)
//
// We DO NOT preload per-package manifests. There are 948 of them (~3 MB total)
// and most are read once or never. Lazy reads via fs.promises.readFile keep
// startup fast and memory low.
//
// The store is created once per server lifetime. If the build runs while the
// server is up, the in-memory _index.json goes stale. We accept that — Phase 4
// will add a file watcher to reload. For now, restart Claude Code after a
// rebuild to pick up changes.

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { CuratedDoc, IndexEntry, LastBuild, Manifest } from "../types.js";
import { memoryDirForPath, readMemories, type MemoryDoc } from "./memory.js";

type Db = Database.Database;

export interface Store {
  kgDir: string;
  index: IndexEntry[]; // _index.json contents
  indexByName: Map<string, IndexEntry>; // O(1) lookup
  curated: CuratedDoc[];
  lastBuild: LastBuild | null;
  // SQLite handle. Null when Phase 3 hasn't run yet (no DB on disk).
  // Opened read-only so concurrent rebuilds don't conflict.
  db: Db | null;
  // Claude Code memory dirs we surface, in priority order. Resolved once at
  // startup (the paths are static); the FILES inside are re-read per call.
  memoryDirs: string[];
  // File ops scoped to this store.
  readManifest(name: string): Promise<Manifest | null>;
  readRepoMap(): Promise<string | null>;
  // Deliberately NOT cached — see the note in memory.ts. Memory mutates
  // mid-session, so a startup snapshot would miss the facts saved during the
  // very session that needs them.
  readMemories(): Promise<MemoryDoc[]>;
}

export interface OpenStoreOptions {
  // Absolute path of the indexed monorepo. Used only to locate ITS memory dir,
  // so facts saved while working in the target repo are recallable from here.
  targetRepo?: string;
  // Absolute path of the devrev-kg checkout, so ITS memory dir is included too.
  // Memory is keyed by CWD slug, and work on the indexer happens in a different
  // CWD than work in the monorepo — without this, the two never see each other,
  // which is the whole problem this feature exists to fix.
  kgRepo?: string;
  // Explicit dirs from $KG_MEMORY_DIRS. When set, these are added ahead of the
  // derived ones — an escape hatch for layouts we can't infer.
  memoryDirs?: string[];
}

// Work out which memory dirs to read.
//
// Native memory is keyed by CWD slug, so the facts relevant to a monorepo are
// split across at least two stores: the target repo's, and this tool's own.
// We collect every plausible dir and let readMemories() skip the ones that
// don't exist (an empty project has no memory dir at all — Claude Code prunes
// them, so "missing" is the common case, not an error).
function deriveMemoryDirs(
  kgDir: string,
  opts: OpenStoreOptions,
  home: string,
): string[] {
  const candidates: string[] = [...(opts.memoryDirs ?? [])];

  // The common deployment has KG_DIR at ~/.claude/projects/<slug>/graph, which
  // puts the matching memory store right next door.
  candidates.push(resolve(kgDir, "..", "memory"));

  if (opts.targetRepo) {
    candidates.push(memoryDirForPath(opts.targetRepo, home));
  }
  if (opts.kgRepo) {
    candidates.push(memoryDirForPath(opts.kgRepo, home));
  }

  // Dedupe, preserving priority order. Overlap is expected, not exceptional:
  // in the documented layout KG_DIR lives under the target repo's project dir,
  // so the first two candidates resolve to the same path.
  return [...new Set(candidates)];
}

export async function openStore(
  kgDir: string,
  opts: OpenStoreOptions = {},
): Promise<Store> {
  const indexPath = join(kgDir, "packages", "_index.json");
  const curatedPath = join(kgDir, "curated.json");
  const lastBuildPath = join(kgDir, "last-build.json");
  const repoMapPath = join(kgDir, "always", "repo-map.md");

  // _index.json must exist; everything else is best-effort.
  const indexRaw = await readFile(indexPath, "utf8").catch(() => null);
  if (!indexRaw) {
    throw new Error(
      `KG not built yet — _index.json missing at ${indexPath}. Run: cd ~/Office/devrev-kg && pnpm kg:full`,
    );
  }
  const index = JSON.parse(indexRaw) as IndexEntry[];
  const indexByName = new Map(index.map((e) => [e.name, e]));

  const curatedRaw = await readFile(curatedPath, "utf8").catch(() => null);
  const curated = curatedRaw ? (JSON.parse(curatedRaw) as CuratedDoc[]) : [];

  const lastBuildRaw = await readFile(lastBuildPath, "utf8").catch(() => null);
  const lastBuild = lastBuildRaw
    ? (JSON.parse(lastBuildRaw) as LastBuild)
    : null;

  // Open the SQLite DB if Phase 3 has produced one. Read-only so a concurrent
  // rebuild can't interfere; WAL mode means our snapshot stays consistent
  // until restart even if the file is replaced via atomicSwap.
  const dbPath = join(kgDir, "db", "kg.sqlite");
  let db: Db | null = null;
  if (existsSync(dbPath)) {
    db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
    db.pragma("query_only = true");
  }

  const memoryDirs = deriveMemoryDirs(kgDir, opts, homedir());

  return {
    kgDir,
    index,
    indexByName,
    curated,
    lastBuild,
    db,
    memoryDirs,
    async readMemories(): Promise<MemoryDoc[]> {
      return readMemories(memoryDirs);
    },
    async readManifest(name: string): Promise<Manifest | null> {
      // Defensive: reject path-traversal attempts via sneaky names.
      if (name.includes("/") || name.includes("..")) return null;
      const path = join(kgDir, "packages", `${name}.json`);
      const exists = await stat(path).catch(() => null);
      if (!exists?.isFile()) return null;
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as Manifest;
    },
    async readRepoMap(): Promise<string | null> {
      return readFile(repoMapPath, "utf8").catch(() => null);
    },
  };
}
