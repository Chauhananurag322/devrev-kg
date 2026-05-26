#!/usr/bin/env node
// MCP server entry point.
//
// Speaks JSON-RPC over stdio. CRITICAL: nothing in this process may write to
// stdout except the SDK's own protocol traffic. All logging goes to stderr
// (already enforced by src/log.ts). Any stray console.log in any imported
// module will silently break the connection — Claude Code drops servers that
// emit non-protocol stdout with no useful error.
//
// Configuration: KG_DIR env var. Set by scripts/wire-devrev-web.mjs to
// "/Users/admin/.claude/projects/-Users-admin-Office-devrev-web/graph". If
// unset, falls back to the default outputDir from config.json.
//
// Tools registered:
//   Phase 2:
//     - get_repo_overview   read-only fallback for SessionStart map
//     - list_packages       filter _index.json by kind/tag/group
//     - get_package         full manifest for one package
//     - find_skill          rank skills by topic match
//   Phase 3a:
//     - find_symbol         exact + FTS fallback over the symbols table
//     - search_code         FTS5 ranked search over name/signature/jsdoc
//   Phase 3b:
//     - who_imports         reverse import lookup grouped by importing package
//     - get_dependency_path BFS over package_deps for shortest dep chain

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openStore } from "./store.js";
import { registerGetRepoOverview } from "./tools/get_repo_overview.js";
import { registerListPackages } from "./tools/list_packages.js";
import { registerGetPackage } from "./tools/get_package.js";
import { registerFindSkill } from "./tools/find_skill.js";
import { registerFindSymbol } from "./tools/find_symbol.js";
import { registerSearchCode } from "./tools/search_code.js";
import { registerWhoImports } from "./tools/who_imports.js";
import { registerGetDependencyPath } from "./tools/get_dependency_path.js";
import { log } from "../log.js";

async function main(): Promise<void> {
  // Resolve KG_DIR. The env var wins — the wiring script sets it, and we want
  // multiple targetRepo configurations to be possible eventually. Falling back
  // to the config.json default keeps `pnpm mcp:start` workable without env vars.
  const kgDir = process.env.KG_DIR ?? (await loadConfig()).outputDir;

  const store = await openStore(kgDir);

  const server = new McpServer(
    { name: "devrev-kg", version: "0.1.0" },
    {
      // Capabilities are auto-derived from registered tools/resources.
      // Explicit instructions help Claude know when to reach for these tools.
      instructions:
        "devrev-kg is a knowledge-graph MCP server for /Users/admin/Office/devrev-web. " +
        "Use these tools instead of grepping the repo: " +
        "list_packages to enumerate or filter projects, " +
        "get_package to retrieve a manifest with dependsOn/dependents/publicExports, " +
        "find_symbol for symbol lookup by name (exact + FTS fallback), " +
        "search_code for FTS5 over name/signature/jsdoc, " +
        "who_imports to find files importing a package or symbol, " +
        "get_dependency_path for the shortest import chain between two packages, " +
        "find_skill to discover relevant SKILL.md files, " +
        "get_repo_overview as a fallback for the always-injected map. " +
        `Loaded ${store.index.length} packages from ${kgDir}.`,
    },
  );

  registerGetRepoOverview(server, store);
  registerListPackages(server, store);
  registerGetPackage(server, store);
  registerFindSkill(server, store);
  registerFindSymbol(server, store);
  registerSearchCode(server, store);
  registerWhoImports(server, store);
  registerGetDependencyPath(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info(
    `mcp server ready: ${store.index.length} packages, ${store.curated.length} curated docs`,
  );
  if (store.lastBuild) {
    const ageMs = Date.now() - new Date(store.lastBuild.builtAt).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    log.info(
      `mcp server: index age ${ageMin}m, phase ${store.lastBuild.phase}, sha ${store.lastBuild.gitSha.slice(0, 7)}`,
    );
  }
}

main().catch((err) => {
  log.error(
    `mcp server failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
