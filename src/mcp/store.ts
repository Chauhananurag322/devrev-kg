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
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CuratedDoc, IndexEntry, LastBuild, Manifest } from "../types.js";

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
  // File ops scoped to this store.
  readManifest(name: string): Promise<Manifest | null>;
  readRepoMap(): Promise<string | null>;
}

export async function openStore(kgDir: string): Promise<Store> {
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

  return {
    kgDir,
    index,
    indexByName,
    curated,
    lastBuild,
    db,
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
