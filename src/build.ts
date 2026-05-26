#!/usr/bin/env node
// CLI entry point. Dispatches subcommands via commander.
//
// Subcommands:
//   kg full        Run a full build (Phase 1 deliverable: nx-graph + curated -> repo-map.md + _index.json)
//   kg affected    Phase 4 — incremental rebuild for given packages (placeholder)
//   kg status      Phase 4 — print last-build.json + age + DB stats (placeholder)
//
// Logs go to stderr; nothing is written to stdout (so `pnpm kg:full | jq` won't
// break, and the MCP server in Phase 2 has stdout exclusively for JSON-RPC).

import { Command } from "commander";
import { loadConfig, buildContext } from "./config.js";
import { loadNxGraph } from "./stages/nx-graph.js";
import { loadCurated } from "./stages/curated.js";
import { loadExports } from "./stages/exports.js";
import { astWalk } from "./stages/ast-walk.js";
import { resolveImports } from "./stages/resolve-imports.js";
import { writeRepoMap } from "./stages/repo-map.js";
import {
  writeCuratedJson,
  writeIndexJson,
  writeLastBuildJson,
  writeManifests,
} from "./writers/json.js";
import { loadAliasMap } from "./util/alias-map.js";
import {
  openDb,
  ensureSchema,
  bulkInsertPackages,
  rebuildSymbolsFts,
  setMeta,
  vacuum,
  atomicSwap,
  dbBytes,
} from "./writers/sqlite.js";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { log, phase } from "./log.js";

async function runFull(): Promise<void> {
  const config = await loadConfig();
  const ctx = await buildContext(config);

  log.info(`targetRepo=${config.targetRepo}`);
  log.info(`outputDir=${config.outputDir}`);

  // Phase 3 pipeline.
  //
  // Sequencing rules:
  //   - loadCurated mutates Pkg.claudeMd; manifests read it, so curated runs first.
  //   - loadExports + loadAliasMap have no inter-dependency; run in parallel.
  //   - astWalk needs PkgRow.id values, so packages get inserted into the
  //     SQLite tmp DB before the worker pool starts handing back files+symbols.
  //   - JSON writers fan out at the end; they touch disjoint files.
  const pkgs = await loadNxGraph(config);
  const docs = await loadCurated(config, pkgs);
  const [exportsByPkg, aliasMap] = await Promise.all([
    loadExports(config, pkgs),
    loadAliasMap(config.targetRepo),
  ]);

  // ---- Phase 3 SQLite build ---------------------------------------------
  // Build to <dbDir>/kg.sqlite.new so concurrent MCP readers keep their
  // open snapshot of the existing kg.sqlite.
  // Clean up any stale tmp DB from a crashed prior build.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = ctx.outputs.dbTmpPath + suffix;
    if (existsSync(path)) await unlink(path);
  }

  const db = await openDb(ctx.outputs.dbTmpPath);
  ensureSchema(db);

  // Insert packages so we have stable ids before the AST walk.
  const sqlitePhase = phase("sqlite-prep");
  const pkgRows = bulkInsertPackages(
    db,
    pkgs.map((p) => {
      const exp = exportsByPkg.get(p.name);
      const firstEntry = exp?.entryFiles[0];
      const alias = firstEntry
        ? aliasMap.fileToAlias.get(`${config.targetRepo}/${firstEntry}`)
        : undefined;
      return {
        name: p.name,
        kind: p.kind,
        root: p.root,
        sourceRoot: p.sourceRoot,
        tags: p.tags,
        ...(alias ? { alias } : {}),
        ...(p.claudeMd ? { claudeMd: p.claudeMd } : {}),
      };
    }),
  );
  const pkgIdByName = new Map(pkgRows.map((r) => [r.name, r.id!]));
  sqlitePhase.end({ packages: pkgRows.length });

  // The actual AST walk. Worker pool, syntactic-only parsing, ~25k files.
  const walkResult = await astWalk(db, config, pkgs, pkgIdByName);

  // Resolve imports -> package_deps using the alias map.
  const resolveResult = resolveImports(db, aliasMap, config.targetRepo);

  // Build the FTS5 index from the populated symbols table.
  rebuildSymbolsFts(db);

  // Stamp meta + vacuum.
  setMeta(db, "built_at", new Date(ctx.startedAt).toISOString());
  setMeta(db, "git_sha", ctx.gitSha);
  setMeta(db, "phase", "3");
  vacuum(db);

  db.close();

  // Atomic swap: kg.sqlite.new -> kg.sqlite (POSIX rename, same FS).
  atomicSwap(ctx.outputs.dbTmpPath, ctx.outputs.dbPath);
  const finalDbBytes = dbBytes(ctx.outputs.dbPath);

  // ---- JSON / markdown outputs (Phase 1+2 surface, unchanged) ------------
  const [, , , manifestsResult] = await Promise.all([
    writeIndexJson(ctx, pkgs),
    writeCuratedJson(ctx, docs),
    writeRepoMap(ctx, pkgs, docs, 4),
    writeManifests(ctx, pkgs, { exportsByPkg, aliasMap }),
  ]);

  await writeLastBuildJson(ctx, {
    packageCount: pkgs.length,
    fileCount: walkResult.fileCount,
    symbolCount: walkResult.symbolCount,
    importCount: walkResult.importCount,
    dbBytes: finalDbBytes,
    phase: 3,
  });

  const totalMs = Date.now() - ctx.startedAt;
  log.info(
    `build complete: ${pkgs.length} packages, ${docs.length} docs, ${manifestsResult.count} manifests, ${walkResult.fileCount} files, ${walkResult.symbolCount} symbols, ${walkResult.importCount} imports, ${resolveResult.resolvedImports} resolved, ${resolveResult.packageEdges} edges, ${(finalDbBytes / 1024 / 1024).toFixed(1)}MB DB, ${totalMs}ms total`,
  );
}

async function runStatus(): Promise<void> {
  const config = await loadConfig();
  const lastBuildPath = `${config.outputDir}/last-build.json`;
  const dbPath = `${config.outputDir}/db/kg.sqlite`;
  if (!existsSync(lastBuildPath)) {
    log.warn("No build yet. Run: pnpm kg:full");
    return;
  }
  const lb = JSON.parse(
    await (await import("node:fs/promises")).readFile(lastBuildPath, "utf8"),
  );
  const ageMin = Math.floor(
    (Date.now() - new Date(lb.builtAt).getTime()) / 60000,
  );
  const targetSha = await (
    await import("./util/git.js")
  ).gitShaShort(config.targetRepo);
  const buildSha = lb.gitSha?.slice(0, 7) ?? "unknown";
  const drift = targetSha !== buildSha ? "  ⚠ drifted" : "  ✓ up-to-date";

  // Pretty print to stderr (which is our log channel).
  // Use process.stderr.write directly so the output is one block, not phase-tagged.
  const lines = [
    "",
    "KG status",
    `  built:        ${lb.builtAt} (${ageMin}m ago)`,
    `  duration:     ${lb.durationMs}ms`,
    `  build sha:    ${buildSha}`,
    `  HEAD sha:     ${targetSha}${drift}`,
    `  phase:        ${lb.phase}`,
    `  packages:     ${lb.packageCount}`,
    `  files:        ${lb.fileCount}`,
    `  symbols:      ${lb.symbolCount}`,
    `  imports:      ${lb.importCount}`,
    `  db size:      ${lb.dbBytes ? (lb.dbBytes / 1024 / 1024).toFixed(1) + "MB" : "0"}`,
    `  db path:      ${dbPath}`,
    "",
  ];
  for (const l of lines) process.stderr.write(l + "\n");
}

async function runAffected(opts: { packages?: string }): Promise<void> {
  // Phase 4 stub: detect what's stale and trigger a full rebuild. For 948
  // packages a full rebuild is ~10s, well under the time anyone would notice
  // for incremental work. We log the affected list for diagnostic value.
  const list = (opts.packages ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    log.warn("kg affected: no --packages provided; nothing to do.");
    return;
  }
  log.info(
    `kg affected: ${list.length} package(s) marked stale: ${list.slice(0, 8).join(", ")}${list.length > 8 ? "..." : ""}`,
  );
  log.info(
    "kg affected: triggering full rebuild (Phase 4 incremental DB delta deferred — full is ~10s).",
  );
  await runFull();
}

async function main(): Promise<void> {
  const program = new Command();
  program.name("kg").description("Knowledge-graph indexer for devrev-web");

  program
    .command("full")
    .description("Full cold build of the knowledge graph")
    .action(async () => {
      try {
        await runFull();
      } catch (err) {
        log.error(
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        process.exit(1);
      }
    });

  program
    .command("affected")
    .description("Incremental rebuild for changed packages (Phase 4)")
    .option("--packages <names>", "Comma-separated list of Nx project names")
    .action(async (opts) => {
      await runAffected(opts);
    });

  program
    .command("status")
    .description(
      "Show last build info, drift against current HEAD, and DB stats (Phase 4)",
    )
    .action(async () => {
      await runStatus();
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
