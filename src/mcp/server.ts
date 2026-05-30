#!/usr/bin/env node
// MCP server entry point.
//
// Speaks JSON-RPC over stdio. CRITICAL: nothing in this process may write to
// stdout except the SDK's own protocol traffic. All logging goes to stderr
// (already enforced by src/log.ts). Any stray console.log in any imported
// module will silently break the connection — Claude Code drops servers that
// emit non-protocol stdout with no useful error.
//
// Configuration: KG_DIR env var. Set by scripts/wire.mjs to the build's
// outputDir (e.g. <devrev-kg>/.kg-output/graph). If unset, falls back to the
// default outputDir from config.json.
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
//
// Resources registered (resources.ts) — standard, cross-client context:
//     - kg://repo-map        the repo overview (markdown)
//     - kg://index           the flat package index (json)
//     - kg://last-build      build metadata (json)
//     - kg://package/{name}  per-package manifest (json template)
//
// Prompts registered (prompts.ts) — cross-client slash commands:
//     - repo_overview        load the repo map as context
//     - package_context      load one package's manifest as context

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
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
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
      // Capabilities are auto-derived from registered tools/resources/prompts.
      // Instructions are kept generic (no hardcoded repo path) so the server
      // is portable across any target monorepo. We use store.index.length —
      // the live count of indexed packages — never the build's packageCount.
      instructions:
        `devrev-kg is a knowledge-graph MCP server for a large Nx monorepo (${store.index.length} packages indexed). ` +
        "For repo context, read the kg://repo-map resource or run the repo_overview prompt — " +
        "that map lists apps, libs grouped by domain, CLAUDE.md paths, skills, and rules. " +
        "Then use these tools instead of grepping the repo: " +
        "list_packages to enumerate or filter projects, " +
        "get_package to retrieve a manifest with dependsOn/dependents/publicExports, " +
        "find_symbol for symbol lookup by name (exact + FTS fallback), " +
        "search_code for FTS5 over name/signature/jsdoc, " +
        "who_imports to find files importing a package or symbol, " +
        "get_dependency_path for the shortest import chain between two packages, " +
        "find_skill to discover relevant SKILL.md files. " +
        "Per-package manifests are also available as kg://package/{name} resources.",
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

  // Standard MCP primitives — resources + prompts — so the repo context is
  // discoverable by ANY client, not just Claude Code's SessionStart hook.
  registerResources(server, store);
  registerPrompts(server, store);

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
