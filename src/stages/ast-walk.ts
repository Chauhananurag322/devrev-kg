// Stage: ast-walk
//
// Worker-pool dispatcher for Phase 3a. Spawns N workers (default os.cpus()-1),
// dispatches packages to them round-robin, and inserts the returned files +
// symbols into SQLite.
//
// SQLite writes happen on the main thread because better-sqlite3 connections
// aren't safe to share across worker_threads. Each per-package result is
// inserted in its own transaction (~5ms each × 948 = ~5s overhead). FTS5
// index is rebuilt once at the end of the walk.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import type { Config, FileRow, ImportRow, Pkg, SymbolRow } from "../types.js";
import { phase, log } from "../log.js";
import {
  bulkInsertFiles,
  bulkInsertImports,
  bulkInsertSymbols,
} from "../writers/sqlite.js";
import type { Db } from "../writers/sqlite.js";

// Mirrors the worker's WorkerFileResult shape. Defined here too so the main
// module doesn't pull in the worker file (which would import typescript).
interface WorkerSymbol {
  name: string;
  kind: SymbolRow["kind"];
  isExported: boolean;
  isDefault: boolean;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  jsdoc?: string;
}

interface WorkerImport {
  moduleSpecifier: string;
  importedName: string | null;
  isTypeOnly: boolean;
}

interface WorkerFileResult {
  path: string;
  language: "ts" | "tsx";
  bytes: number;
  isIndexFile: boolean;
  symbols: WorkerSymbol[];
  imports: WorkerImport[];
}

interface WorkerResultMsg {
  pkg: string;
  files: WorkerFileResult[];
  error?: string;
}

export async function astWalk(
  db: Db,
  config: Config,
  pkgs: Pkg[],
  pkgIdByName: Map<string, number>,
): Promise<{
  fileCount: number;
  symbolCount: number;
  importCount: number;
  failedPackages: number;
}> {
  const p = phase("ast-walk");

  const poolSize = Math.max(2, config.concurrency || cpus().length - 1);
  const workerScript = fileURLToPath(
    new URL("./ast-worker.js", import.meta.url),
  );

  const queue = pkgs.slice();
  let totalFiles = 0;
  let totalSymbols = 0;
  let totalImports = 0;
  let failedPackages = 0;

  function handleResult(msg: WorkerResultMsg): void {
    if (msg.error) {
      log.warn(`ast-walk: ${msg.pkg} failed: ${msg.error}`);
      failedPackages++;
      return;
    }
    const pkgId = pkgIdByName.get(msg.pkg);
    if (pkgId === undefined) {
      log.warn(`ast-walk: ${msg.pkg} has no DB id (was it filtered out?)`);
      return;
    }

    if (msg.files.length === 0) {
      // No source files (e.g. apps/* without src). Nothing to insert.
      return;
    }

    // Insert files first to get fileIds.
    const fileRowInputs: FileRow[] = msg.files.map((f) => ({
      packageId: pkgId,
      path: f.path,
      language: f.language,
      bytes: f.bytes,
      isIndexFile: f.isIndexFile,
    }));
    const fileRows = bulkInsertFiles(db, fileRowInputs);

    // Build symbol + import rows with the right fileIds.
    const symbolRows: SymbolRow[] = [];
    const importRows: ImportRow[] = [];
    for (let i = 0; i < msg.files.length; i++) {
      const file = msg.files[i];
      const fileId = fileRows[i]?.id;
      if (file === undefined || fileId === undefined) continue;
      for (const s of file.symbols) {
        symbolRows.push({
          fileId,
          name: s.name,
          kind: s.kind,
          isExported: s.isExported,
          isDefault: s.isDefault,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
          ...(s.signature ? { signature: s.signature } : {}),
          ...(s.jsdoc ? { jsdoc: s.jsdoc } : {}),
        });
      }
      for (const imp of file.imports) {
        importRows.push({
          fileId,
          moduleSpecifier: imp.moduleSpecifier,
          importedName: imp.importedName,
          isTypeOnly: imp.isTypeOnly,
        });
      }
    }
    if (symbolRows.length > 0) bulkInsertSymbols(db, symbolRows);
    if (importRows.length > 0) bulkInsertImports(db, importRows);

    totalFiles += msg.files.length;
    totalSymbols += symbolRows.length;
    totalImports += importRows.length;
  }

  await Promise.all(
    Array.from({ length: poolSize }, () =>
      runWorker(workerScript, config, queue, handleResult),
    ),
  );

  p.end({
    files: totalFiles,
    symbols: totalSymbols,
    imports: totalImports,
    failed_pkgs: failedPackages,
    workers: poolSize,
  });

  return {
    fileCount: totalFiles,
    symbolCount: totalSymbols,
    importCount: totalImports,
    failedPackages,
  };
}

// One Worker per pool slot; processes many packages by pulling from the queue.
// Workers are recycled across packages — we don't pay per-package spawn cost.
function runWorker(
  scriptPath: string,
  config: Config,
  queue: Pkg[],
  onResult: (msg: WorkerResultMsg) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new Worker(scriptPath, {
      workerData: {
        targetRepo: config.targetRepo,
        excludeGlobs: config.excludeGlobs,
      },
    });

    let active = false;

    const next = (): void => {
      const pkg = queue.shift();
      if (!pkg) {
        // Queue drained. Terminate this worker.
        w.terminate()
          .then(() => resolve())
          .catch(reject);
        return;
      }
      active = true;
      w.postMessage({ pkg });
    };

    w.on("message", (msg: WorkerResultMsg) => {
      try {
        onResult(msg);
      } catch (err) {
        reject(err);
        w.terminate().catch(() => {});
        return;
      } finally {
        active = false;
      }
      next();
    });

    w.on("error", (err) => {
      reject(err);
      w.terminate().catch(() => {});
    });

    w.on("exit", (code) => {
      if (code !== 0 && active) {
        reject(
          new Error(`ast-walk worker exited unexpectedly with code ${code}`),
        );
      }
    });

    next(); // kick off first job
  });
}
