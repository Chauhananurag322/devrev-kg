# devrev-kg — Knowledge Graph for an Nx monorepo

> **Note:** This is the original architecture-design doc, captured as it was when the project was scoped. Paths like `/Users/admin/Office/devrev-web` are illustrative — they reflect the author's local layout. The released code is config-driven; see [README.md](./README.md) for setup.

Personal tool that indexes a target Nx monorepo (Nx, 19 apps, 144 libs at the time of writing — the actual graph at build time has ~948 projects) and exposes the graph via an MCP server to Claude Code, drastically reducing token consumption.

## Full plan

See: `~/.claude/plans/i-want-to-create-lovely-wolf.md` for the complete implementation plan with architecture, DB schema, stage details, and phased rollout.

---

## Quick summary

### What this repo does

1. **Builder** (`src/build.ts`) — reads devrev-web source code, Nx project graph, CLAUDE.md files, and skills. Writes outputs to `$KG` (see below).
2. **MCP Server** (`src/mcp/server.ts`) — exposes 8 query tools (find_symbol, who_imports, get_package, list_packages, search_code, get_dependency_path, find_skill, get_repo_overview) backed by a SQLite DB.

### Output location (`$KG`)

```
~/.claude/projects/-Users-admin-Office-devrev-web/graph/
├── always/repo-map.md      (injected into every Claude session via SessionStart hook, ~2k tokens)
├── packages/<name>.json    (per-package manifests, read on demand by MCP)
├── packages/_index.json    (lookup index)
└── db/kg.sqlite            (FTS5-enabled SQLite, MCP backing store)
```

### Config

`config.json` in this repo root:
```json
{
  "targetRepo": "/Users/admin/Office/devrev-web",
  "outputDir": "/Users/admin/.claude/projects/-Users-admin-Office-devrev-web/graph",
  "nxBin": "pnpm nx"
}
```

### Tech stack

- TypeScript (compiled via `tsx` for dev, `tsc` for dist)
- TS Compiler API (for AST walking + import resolution)
- better-sqlite3 (WAL mode, FTS5)
- @modelcontextprotocol/sdk (stdio transport)
- commander (CLI)
- glob (file discovery)

### Dependencies to install

```json
{
  "dependencies": {
    "better-sqlite3": "^11",
    "@modelcontextprotocol/sdk": "^1",
    "commander": "^12",
    "glob": "^11"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "tsx": "^4",
    "@types/better-sqlite3": "^7",
    "@types/node": "^20"
  }
}
```

### Phased build order

1. **Phase 1** (start here) — Nx graph + curated ingest → `repo-map.md` + `_index.json`. Wire SessionStart hook.
2. **Phase 2** — JSON manifests per package (parse `index.ts` exports). MCP server with `get_package`, `list_packages`, `find_skill`.
3. **Phase 3** — Full AST walk → SQLite with symbols/imports/FTS5. Add `find_symbol`, `who_imports`, `search_code`, `get_dependency_path`.
4. **Phase 4** — Incremental rebuild via `nx affected`. Pre-commit hook in devrev-web.

### Registration (in devrev-web's `.claude/settings.local.json`)

```json
{
  "mcpServers": {
    "kg": {
      "command": "node",
      "args": ["/Users/admin/Office/devrev-kg/dist/mcp/server.js"],
      "env": { "KG_DIR": "/Users/admin/.claude/projects/-Users-admin-Office-devrev-web/graph" }
    }
  },
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "cat /Users/admin/.claude/projects/-Users-admin-Office-devrev-web/graph/always/repo-map.md 2>/dev/null || echo '[KG not built yet — run: cd ~/Office/devrev-kg && pnpm kg:full]'"
      }]
    }]
  }
}
```

### DB schema (SQLite)

- `packages(id, name, kind, root, source_root, tags, claude_md_path, public_export_count, file_count)`
- `files(id, package_id, path, language, bytes, is_index_file, last_mtime, sha)`
- `symbols(id, file_id, name, kind, is_exported, is_default_export, line_start, line_end, signature, jsdoc)`
- `imports(id, file_id, module_specifier, imported_name, is_type_only, resolved_file_id, resolved_package_id)`
- `package_deps(from_package_id, to_package_id, edge_count)`
- `claude_docs(id, kind, path, package_id, title, body_chunks_json)`
- `meta(key, value)`
- FTS5: `symbols_fts(name, signature, jsdoc)`

### Key design decisions

- TS Compiler API over tree-sitter (needs tsconfig path resolution for `@devrev-web/*` aliases)
- One `ts.Program` per Nx project (not per file) with shared `ModuleResolutionCache`
- Type checker invoked only at export sites (not every node)
- SQLite WAL mode; build to `kg.sqlite.new` then atomic `rename(2)`
- MCP server opens DB read-only; handles concurrent sessions fine
- Pre-commit hook is backgrounded + non-fatal (never blocks commits)
