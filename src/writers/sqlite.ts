// SQLite persistence layer for Phase 3.
//
// Data backbone for AST-derived symbols. The MCP server opens this DB
// read-only at runtime; the build pipeline opens it read-write inside an
// atomic write-then-rename pattern so concurrent readers never see partial state.
//
// Key choices (rationale lives at each call site):
//   - WAL mode + synchronous=NORMAL: 3-4x faster bulk writes, safe vs power loss.
//   - FTS5 with content='symbols': free disk for full-text search over symbol
//     names / signatures / jsdoc.
//   - foreign_keys=ON + ON DELETE CASCADE: Phase 4 `kg affected` deletes a
//     package row and gets its files+symbols cleared automatically.
//   - signature/jsdoc truncated at 500 chars: bounds DB size; deeply generic
//     React component signatures can run 2-3k chars otherwise.
//
// Schema version is stored in `meta.schema_version`. Bumping the version causes
// the next build to drop and recreate every table — there are no migrations
// because rebuilds are cheap (single-digit minutes) and the data is derived,
// not authoritative.

import Database from "better-sqlite3";
import { renameSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "../util/fs-atomic.js";
import { phase as logPhase } from "../log.js";
import type {
  FileRow,
  ImportRow,
  PackageDepRow,
  PkgRow,
  SymbolRow,
} from "../types.js";

export type Db = Database.Database;

export const SCHEMA_VERSION = "1";

const SIG_CAP = 500;
const JSDOC_CAP = 500;

function truncate(s: string | undefined, cap: number): string | null {
  if (!s) return null;
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1) + "...";
}

// ---- Open / pragmas -----------------------------------------------------

export async function openDb(path: string): Promise<Db> {
  await ensureDir(dirname(path));
  const db = new Database(path);

  // WAL: concurrent readers + 1 writer, atomic-commit semantics.
  db.pragma("journal_mode = WAL");
  // synchronous=NORMAL is safe with WAL and several x faster than FULL.
  db.pragma("synchronous = NORMAL");
  // Sort/index temp tables in RAM, not /var/db.
  db.pragma("temp_store = MEMORY");
  // 256 MB mmap window for reads. Covers most of our DB on hot pages.
  db.pragma("mmap_size = 268435456");
  // SQLite ships with FKs disabled. Phase 4's per-package wipe relies on
  // CASCADE, so this MUST be on.
  db.pragma("foreign_keys = ON");

  return db;
}

// ---- Schema -------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('app','lib')),
  root          TEXT NOT NULL,
  source_root   TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  alias         TEXT,
  claude_md     TEXT
);
CREATE INDEX IF NOT EXISTS idx_packages_kind ON packages(kind);

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  package_id    INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  path          TEXT NOT NULL UNIQUE,
  language      TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  is_index_file INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_package ON files(package_id);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  is_exported INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  signature   TEXT,
  jsdoc       TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file      ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_exported_name
  ON symbols(name) WHERE is_exported = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, jsdoc,
  content='symbols', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS imports (
  id                   INTEGER PRIMARY KEY,
  file_id              INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  module_specifier     TEXT NOT NULL,
  imported_name        TEXT,
  is_type_only         INTEGER NOT NULL DEFAULT 0,
  resolved_file_id     INTEGER REFERENCES files(id) ON DELETE SET NULL,
  resolved_package_id  INTEGER REFERENCES packages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_specifier  ON imports(module_specifier);
CREATE INDEX IF NOT EXISTS idx_imports_resolved_pkg ON imports(resolved_package_id);
CREATE INDEX IF NOT EXISTS idx_imports_file       ON imports(file_id);

CREATE TABLE IF NOT EXISTS package_deps (
  from_package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  to_package_id   INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  edge_count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (from_package_id, to_package_id)
);
CREATE INDEX IF NOT EXISTS idx_package_deps_to ON package_deps(to_package_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function ensureSchema(db: Db): void {
  // First-time-open: meta table won't exist; the prepare-then-get below would
  // fail. Create the meta table explicitly first so we can read schema_version.
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );

  const versionRow = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;

  if (versionRow && versionRow.value !== SCHEMA_VERSION) {
    dropAll(db);
    // Re-create the meta table after dropAll so the version stamp below works.
    db.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    );
  }

  db.exec(SCHEMA_SQL);

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_VERSION);
}

function dropAll(db: Db): void {
  // FTS5 virtual tables aren't covered by FK cascades. Drop in reverse-dep order.
  db.exec(`
    DROP TABLE IF EXISTS symbols_fts;
    DROP TABLE IF EXISTS package_deps;
    DROP TABLE IF EXISTS imports;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS packages;
    DROP TABLE IF EXISTS meta;
  `);
}

// Wipe rows for a fresh full build, keeping the schema intact. Used when
// build.ts opts to rebuild in place rather than via the .new+rename path.
export function clearForRebuild(db: Db): void {
  db.exec(`
    DELETE FROM package_deps;
    DELETE FROM imports;
    DELETE FROM symbols;
    DELETE FROM files;
    DELETE FROM packages;
    INSERT INTO symbols_fts(symbols_fts) VALUES('delete-all');
  `);
}

// ---- Bulk inserts -------------------------------------------------------
//
// All three insert helpers wrap their loop in db.transaction() so 200k inserts
// commit in one fsync (~5s) rather than 200k (~hours). Each populates `id`
// from lastInsertRowid so callers can wire foreign-key references.

export function bulkInsertPackages(db: Db, rows: PkgRow[]): PkgRow[] {
  const stmt = db.prepare(
    `INSERT INTO packages (name, kind, root, source_root, tags, alias, claude_md)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((batch: PkgRow[]) => {
    for (const r of batch) {
      const info = stmt.run(
        r.name,
        r.kind,
        r.root,
        r.sourceRoot,
        JSON.stringify(r.tags),
        r.alias ?? null,
        r.claudeMd ?? null,
      );
      r.id = Number(info.lastInsertRowid);
    }
  });
  txn(rows);
  return rows;
}

export function bulkInsertFiles(db: Db, rows: FileRow[]): FileRow[] {
  const stmt = db.prepare(
    `INSERT INTO files (package_id, path, language, bytes, is_index_file)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((batch: FileRow[]) => {
    for (const r of batch) {
      const info = stmt.run(
        r.packageId,
        r.path,
        r.language,
        r.bytes,
        r.isIndexFile ? 1 : 0,
      );
      r.id = Number(info.lastInsertRowid);
    }
  });
  txn(rows);
  return rows;
}

export function bulkInsertSymbols(db: Db, rows: SymbolRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO symbols
     (file_id, name, kind, is_exported, is_default, line_start, line_end, signature, jsdoc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((batch: SymbolRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.fileId,
        r.name,
        r.kind,
        r.isExported ? 1 : 0,
        r.isDefault ? 1 : 0,
        r.lineStart,
        r.lineEnd,
        truncate(r.signature, SIG_CAP),
        truncate(r.jsdoc, JSDOC_CAP),
      );
    }
  });
  txn(rows);
}

// Bulk insert imports. Resolved fields default to null; resolveImports() fills
// them in a separate pass after all imports are loaded.
export function bulkInsertImports(db: Db, rows: ImportRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO imports
     (file_id, module_specifier, imported_name, is_type_only, resolved_file_id, resolved_package_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((batch: ImportRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.fileId,
        r.moduleSpecifier,
        r.importedName,
        r.isTypeOnly ? 1 : 0,
        r.resolvedFileId ?? null,
        r.resolvedPackageId ?? null,
      );
    }
  });
  txn(rows);
}

// Bulk insert package_deps rows aggregated from imports. Composite PK so we
// can ON CONFLICT update edge_count.
export function bulkInsertPackageDeps(db: Db, rows: PackageDepRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO package_deps (from_package_id, to_package_id, edge_count)
     VALUES (?, ?, ?)
     ON CONFLICT(from_package_id, to_package_id) DO UPDATE SET edge_count = edge_count + excluded.edge_count`,
  );
  const txn = db.transaction((batch: PackageDepRow[]) => {
    for (const r of batch) {
      stmt.run(r.fromPackageId, r.toPackageId, r.edgeCount);
    }
  });
  txn(rows);
}

// Rebuild the FTS5 index from the symbols table. Run once after all symbol
// inserts. With content='symbols', this populates the inverted index by
// reading from the source table — no separate text duplication.
export function rebuildSymbolsFts(db: Db): void {
  const p = logPhase("fts-rebuild");
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  p.end();
}

// ---- Meta + finalize ----------------------------------------------------

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function vacuum(db: Db): void {
  // VACUUM rewrites the file to defragment and reclaim space.
  db.exec("VACUUM");
}

// ---- Atomic swap (build-to-tmp, then rename) ---------------------------

export function atomicSwap(tmpPath: string, finalPath: string): void {
  if (!existsSync(tmpPath)) {
    throw new Error(`atomicSwap: tmp DB ${tmpPath} does not exist`);
  }
  // POSIX rename(2) is atomic when source and dest live on the same FS.
  renameSync(tmpPath, finalPath);
  // Best-effort: also rename WAL/SHM sidecars if they exist.
  for (const suffix of ["-wal", "-shm"]) {
    const tmpSide = tmpPath + suffix;
    const finalSide = finalPath + suffix;
    if (existsSync(tmpSide)) {
      try {
        renameSync(tmpSide, finalSide);
      } catch {
        // Non-fatal — sidecars are recoverable.
      }
    }
  }
}

export function dbBytes(path: string): number {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

// ---- Convenience wrapper ------------------------------------------------

// Wrap arbitrary work in a transaction. Useful for the AST walker which
// inserts files + symbols across many packages and we want the per-package
// batch to be atomic.
export function withTransaction<T>(db: Db, fn: () => T): T {
  const txn = db.transaction(fn);
  return txn();
}
