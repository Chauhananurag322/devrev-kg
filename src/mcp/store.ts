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
// HOT RELOAD
//
// The loaded state above is a snapshot, and a rebuild invalidates it. Worse
// than stale JSON: writers/sqlite.ts finishes with an atomic rename(2), so our
// open SQLite handle keeps pointing at the *unlinked* old inode. It answers
// happily and forever with pre-rebuild data — a silent wrong answer, which is
// the worst failure mode for a tool whose whole job is being trusted over grep.
// That is what forced "restart Claude Code after a rebuild".
//
// So every tool call goes through ensureFresh() first: stat last-build.json and,
// if its mtime moved, reload the JSON and reopen the DB. Rationale for stat-on-
// demand over fs.watch:
//   - correct across the atomic swap (watching an inode that gets replaced is
//     exactly the case fs.watch handles worst)
//   - no watcher leaks, no debounce, no platform differences
//   - a stat is ~10µs; tool calls are milliseconds. Cost is noise.
// A short TTL keeps a burst of calls from stat-ing on every single one.

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
  // MUTABLE: replaced wholesale by a reload. Tools must not capture these
  // across an await — read store.index at point of use, not into a local.
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
  // Reload if the build on disk is newer than what we hold. Every tool calls
  // this first; it is a cheap stat in the common case.
  ensureFresh(): Promise<void>;
  // How many times we've reloaded. Surfaced by get_repo_overview for debugging
  // "is the server actually seeing my rebuild?".
  reloads: number;
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

// Re-stat no more often than this. A tool call burst (agents fire several in a
// row) then costs one stat, not one per call. 2s is far below the ~12s rebuild,
// so a fresh build is still picked up on effectively the next call.
const FRESHNESS_TTL_MS = 2000;

export async function openStore(
  kgDir: string,
  opts: OpenStoreOptions = {},
): Promise<Store> {
  const indexPath = join(kgDir, "packages", "_index.json");
  const curatedPath = join(kgDir, "curated.json");
  const lastBuildPath = join(kgDir, "last-build.json");
  const repoMapPath = join(kgDir, "always", "repo-map.md");
  const dbPath = join(kgDir, "db", "kg.sqlite");

  // Mutable slots. `store` below closes over these, so a reload swaps the data
  // out from under every already-registered tool without re-registering.
  let index: IndexEntry[] = [];
  let indexByName = new Map<string, IndexEntry>();
  let curated: CuratedDoc[] = [];
  let lastBuild: LastBuild | null = null;
  let db: Db | null = null;

  // mtime of last-build.json as of our last load — the staleness sentinel.
  // The build writes it last, after the DB swap, so if it has moved then the
  // rest of the outputs are already in place.
  let loadedMtimeMs = 0;
  let lastCheckedAt = 0;
  let reloads = 0;

  async function load(isReload: boolean): Promise<void> {
    // _index.json must exist; everything else is best-effort.
    const indexRaw = await readFile(indexPath, "utf8").catch(() => null);
    if (!indexRaw) {
      if (isReload) return; // mid-rebuild; keep serving what we have
      throw new Error(
        `KG not built yet — _index.json missing at ${indexPath}. Run: cd ~/Office/devrev-kg && pnpm kg:full`,
      );
    }

    // A rebuild rewrites these files while we may be reading them. Every write
    // is atomic (writeFileAtomic → rename), so we never see a torn file — but a
    // JSON parse error still shouldn't take the server down mid-session.
    try {
      const parsedIndex = JSON.parse(indexRaw) as IndexEntry[];
      index = parsedIndex;
      indexByName = new Map(parsedIndex.map((e) => [e.name, e]));
    } catch (err) {
      if (!isReload) throw err;
      return; // keep the previous good snapshot
    }

    const curatedRaw = await readFile(curatedPath, "utf8").catch(() => null);
    curated = curatedRaw ? (JSON.parse(curatedRaw) as CuratedDoc[]) : [];

    const lastBuildRaw = await readFile(lastBuildPath, "utf8").catch(() => null);
    lastBuild = lastBuildRaw ? (JSON.parse(lastBuildRaw) as LastBuild) : null;

    // Reopen the DB. REQUIRED, not just nice-to-have: the build ends in an
    // atomic rename, so the old handle points at an unlinked inode and would
    // keep serving pre-rebuild rows indefinitely.
    if (db) {
      try {
        db.close();
      } catch {
        // Already closed / never fully opened. Nothing to recover.
      }
      db = null;
    }
    if (existsSync(dbPath)) {
      try {
        db = new Database(dbPath, { readonly: true });
        db.pragma("journal_mode = WAL");
        db.pragma("query_only = true");
      } catch {
        // Swap raced us. Leave db null; the next ensureFresh() retries, and
        // tools already handle a null db (Phase-3-not-built path).
        db = null;
      }
    }

    const st = await stat(lastBuildPath).catch(() => null);
    loadedMtimeMs = st?.mtimeMs ?? 0;
    if (isReload) reloads += 1;
  }

  await load(false);

  const memoryDirs = deriveMemoryDirs(kgDir, opts, homedir());

  return {
    kgDir,
    get index() {
      return index;
    },
    get indexByName() {
      return indexByName;
    },
    get curated() {
      return curated;
    },
    get lastBuild() {
      return lastBuild;
    },
    get db() {
      return db;
    },
    get reloads() {
      return reloads;
    },
    memoryDirs,
    async ensureFresh(): Promise<void> {
      const now = Date.now();
      if (now - lastCheckedAt < FRESHNESS_TTL_MS) return;
      lastCheckedAt = now;

      const st = await stat(lastBuildPath).catch(() => null);
      if (!st) return; // never built, or mid-swap — keep current snapshot
      if (st.mtimeMs === loadedMtimeMs) return;

      await load(true);
    },
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
