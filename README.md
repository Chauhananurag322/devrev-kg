# devrev-kg

Knowledge-graph indexer + MCP server for large Nx monorepos. Designed to make Claude Code dramatically more efficient when working in repos with hundreds of packages.

Built originally for a private monorepo with **948 Nx projects, ~27k TS/TSX files, ~66k symbols, ~180k imports**. The same code works for any Nx monorepo with TypeScript path aliases.

## Why

Every fresh agent session in a large monorepo starts from zero. To answer "where does `SprintSettingsWidget` live?" or "what apps exist here?", the agent burns tokens on `ls`, `Glob`, `Grep`, and reading multiple files. Across many sessions this is repeated waste.

devrev-kg pre-indexes the repo into a small SQLite database with FTS5 and exposes it over an MCP stdio server as **8 tools, 4 resources, and 2 prompts** — so any MCP client (Cursor, Cline, Zed, Claude Code) gets the context, not just Claude Code via a session-start hook. Net effect:

| Question | Without KG | With KG |
|---|---|---|
| "What apps are in this repo?" | 3-5 tool calls + reading | 0 tool calls (in injected context) |
| "Where is `SprintSettingsWidget` defined?" | 5-10 `Glob` + `Grep` + `Read` | 1 `mcp__kg__find_symbol` call |
| "Who imports `data-layer-dl-utils`?" | repo-wide grep, 10s+ | 1 `mcp__kg__who_imports` call, <100ms |

A full cold rebuild of the index runs in ~10 seconds on an M-series Mac.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  devrev-kg (this repo)                                      │
│                                                             │
│  ┌──────────┐    ┌────────────┐    ┌─────────────────────┐  │
│  │ src/     │ ── │ pnpm       │ ── │ outputDir/          │  │
│  │ build.ts │    │ kg:full    │    │   always/repo-map.md│  │
│  └──────────┘    └────────────┘    │   packages/*.json   │  │
│                                    │   db/kg.sqlite      │  │
│  ┌──────────────┐                  │   curated.json      │  │
│  │ src/mcp/     │ ◀────────────────│   last-build.json   │  │
│  │ server.ts    │                  └─────────────────────┘  │
│  └──────────────┘                                           │
│       │                                                     │
└───────┼─────────────────────────────────────────────────────┘
        │ stdio JSON-RPC
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Any MCP client (Cursor · Cline · Zed · Claude Code)        │
│  ─ Resources (kg://repo-map, kg://package/{name}, …)        │
│  ─ Prompts   (repo_overview, package_context)               │
│  ─ Tools     (mcp__kg__find_symbol, who_imports, …)         │
│  ─ Claude Code only: SessionStart hook auto-injects the map │
└─────────────────────────────────────────────────────────────┘
```

The build pipeline:

1. **Nx graph dump** — runs `pnpm nx graph` against your monorepo, normalizes nodes
2. **Curated ingest** — finds CLAUDE.md / `.shared/rules/*.md` / `.claude/skills/**/SKILL.md`
3. **Exports walk** — syntactically reads every package's `index.ts(x)` (no type checker)
4. **Alias map** — parses `tsconfig.base.json` `paths`
5. **AST walk** — `worker_threads` pool, parses every `.ts/.tsx`, emits symbols + imports
6. **Resolve imports** — alias-map lookup → package_deps edges
7. **Write outputs** — `_index.json`, per-package manifests, repo-map.md, atomic SQLite swap

## Tools exposed by the MCP server

| Tool | Purpose |
|---|---|
| `get_repo_overview` | Returns the always-injected repo-map markdown verbatim. |
| `list_packages({ kind?, tag?, glob? })` | Filter the package list by kind/tag/group. |
| `get_package(name)` | Return the full manifest: tags, alias, dependsOn, dependents, exports, fileCount. |
| `find_skill(topic)` | Rank `.claude/skills/**/SKILL.md` files by topic relevance. |
| `find_symbol({ name, kind?, exported_only?, package? })` | Exact match on symbol name; FTS5 fallback. |
| `search_code({ query, package? })` | FTS5 search over symbol name + signature + jsdoc. |
| `who_imports({ target, type_only? })` | Reverse lookup: which packages import a symbol or package, grouped. |
| `get_dependency_path({ from, to, max_depth? })` | BFS over `package_deps`. Shortest import chain. |

## Resources exposed by the MCP server

Resources are the **standard, cross-client** way to surface read-only context. Any MCP client (Cursor, Cline, Zed, Claude Code) auto-discovers them on connect via `resources/list` — no client-specific hook required. They use a custom `kg://` URI scheme (these are not files on your disk; the index lives under `KG_DIR`).

| Resource URI | Type | Contents |
|---|---|---|
| `kg://repo-map` | `text/markdown` | The repo overview map (apps, libs by domain, CLAUDE.md/skill paths, rules). **The primary context to load first.** |
| `kg://index` | `application/json` | Flat array of every package: `{ name, kind, root, tags, group }`. |
| `kg://last-build` | `application/json` | Build metadata (`builtAt`, `gitSha`, counts, phase) — for staleness checks. |
| `kg://package/{name}` | `application/json` | Per-package manifest (template). The enumerated list is capped at 200, but **any** package name is readable; use `kg://index` or `list_packages` for the full set. |

## Prompts exposed by the MCP server

Prompts are the cross-client "slash command" primitive. They return user-role context messages.

| Prompt | Args | Purpose |
|---|---|---|
| `repo_overview` | — | Loads the repo map as context. The portable, on-demand replacement for the SessionStart hook. |
| `package_context` | `name` | Loads one package's manifest (deps, dependents, public exports) as context. |

## Cross-client usage

The resources and prompts above make the repo context available **without** the Claude-Code-specific SessionStart hook:

> The prefix matches the **server name you register** (`claude mcp add <name> …`). The examples below use `kg`; if you register it under a different name, substitute accordingly.

- **Claude Code** — mention a resource in a message with `@kg:kg://repo-map`, or run a prompt as a slash command: `/mcp__kg__repo_overview`. (These complement the optional SessionStart hook from `pnpm wire`, which auto-injects the map at session start.)
- **Cursor / Cline / Zed** — once the server is registered, resources appear in the client's MCP resource picker and prompts appear as commands automatically. No SessionStart hook needed — that's the point of exposing these primitives.

## Requirements

- **Target repo**: an Nx monorepo with `tsconfig.base.json` `paths` aliases
- **Node** 22.22+ (`.nvmrc`)
- **pnpm** 10+
- **Claude Code** with MCP support
- macOS or Linux (POSIX `rename(2)` for atomic DB swap, `worker_threads` for parallelism)

## Install

The simplest layout: this repo and your target monorepo as siblings.

```
my-projects/
├── devrev-kg/         ← clone this here
└── my-monorepo/       ← your Nx monorepo
```

Then:

```bash
git clone https://github.com/Chauhananurag322/devrev-kg.git
cd devrev-kg
cp config.example.json config.json
# Edit config.json — change "targetRepo" to point at your monorepo

pnpm install
pnpm build
pnpm kg:full
```

`pnpm kg:full` writes the index to `devrev-kg/.kg-output/graph` (the default `KG_DIR`).

Then register the MCP server with Claude Code. Run this **from inside your monorepo** so the server binds to that project's scope:

```bash
cd ../my-monorepo
claude mcp add kg --scope local \
  --env KG_DIR="$(pwd)/../devrev-kg/.kg-output/graph" \
  -- node "$(pwd)/../devrev-kg/dist/mcp/server.js"

# Restart Claude Code
```

After restart, `/mcp` lists the `kg` server with its **8 tools, 4 resources, and 2 prompts**. This is all any MCP client needs — the same `node …/server.js` + `KG_DIR` works in Cursor, Cline, and Zed.

### Optional: auto-inject the map (Claude Code only)

To also have the repo-map injected at every session start (and a background rebuild trigger on session start):

```bash
cd ../devrev-kg
pnpm wire    # adds a SessionStart hook to your monorepo's .claude/settings.local.json
```

This is a Claude-Code convenience layered on top — the resources/prompts above already make the context available everywhere without it.

## Configuration

`config.json` — only `targetRepo` is required. Relative paths resolve against the kg repo root, so `"../my-monorepo"` works regardless of where you invoke the CLI.

```json
{
  "targetRepo": "../my-monorepo"
}
```

Optional fields:

| Field | Default | Notes |
|---|---|---|
| `outputDir` | `./.kg-output/graph` | Where the index, manifests, repo-map.md live. |
| `tmpDir` | `<outputDir>/.tmp` | Scratch dir for nx graph dumps. |
| `nxBin` | `"pnpm nx"` | Shell command to run nx in the target repo. |
| `concurrency` | `8` | AST-walk worker pool size. |
| `excludeGlobs` | (sensible defaults) | Test/story/mock file patterns to skip. |

## CLI

```bash
pnpm kg:full       # full cold build
pnpm kg:status     # show last-build info, age, sha drift
pnpm kg:affected   # incremental rebuild (currently triggers full; ~10s)

pnpm mcp:start     # start MCP server (for manual stdio testing)
pnpm mcp:inspect   # MCP Inspector
```

## How rebuilds happen

After running `pnpm wire`, every Claude Code session in your target repo runs a `maybe-rebuild.sh` hook on startup. It:

1. Reads the kg's recorded `gitSha` from `last-build.json`
2. Compares to the target repo's current `git rev-parse HEAD`
3. If drifted, fires `pnpm kg:full` in the **background** and returns immediately

The rebuild finishes ~10s later. Your **next** Claude session sees the fresh data; the current session keeps its consistent snapshot until restarted.

To force a fresh rebuild manually: `pnpm kg:full`. Restart Claude Code to consume it.

## Repo layout

```
devrev-kg/
├── src/
│   ├── build.ts                 CLI entry (commander)
│   ├── config.ts                config loader + BuildContext
│   ├── log.ts                   stderr logger + phase timer
│   ├── types.ts                 shared interfaces
│   ├── stages/
│   │   ├── nx-graph.ts          spawn `pnpm nx graph`, normalize
│   │   ├── curated.ts           CLAUDE.md / rules / skills scan
│   │   ├── exports.ts           syntactic walk of each package's index.ts(x)
│   │   ├── ast-worker.ts        worker_threads worker (per-file AST walk)
│   │   ├── ast-walk.ts          worker pool dispatcher
│   │   ├── resolve-imports.ts   alias-map → package_deps
│   │   └── repo-map.ts          assemble the markdown overview
│   ├── writers/
│   │   ├── json.ts              _index.json, manifests, last-build.json
│   │   └── sqlite.ts            schema, FTS5, atomic swap, transactions
│   ├── mcp/
│   │   ├── server.ts            stdio MCP entry
│   │   ├── store.ts             read-only data store
│   │   ├── resources.ts         kg:// resources (repo-map, index, package/{name})
│   │   ├── prompts.ts           repo_overview / package_context prompts
│   │   └── tools/               one file per tool
│   └── util/
│       ├── alias-map.ts         tsconfig.base.json paths parser
│       ├── fs-atomic.ts         writeFileAtomic (write→fsync→rename)
│       ├── git.ts               gitSha helpers
│       └── glob-helpers.ts      glob with always-ignore safety net
├── scripts/
│   ├── wire.mjs                 install SessionStart hooks
│   └── maybe-rebuild.sh         background rebuild trigger
├── config.example.json
├── PLAN.md                      original architecture plan
└── README.md
```

## Roadmap

- File-watcher to live-reload the MCP server's DB handle when kg.sqlite changes (eliminates the "restart Claude after rebuild" step)
- True incremental `kg:affected` (currently triggers a full rebuild)
- Expose curated docs (CLAUDE.md / rules / skills) as `kg://` resources once the build writes their bodies into `KG_DIR` (currently only metadata is indexed)
- Generalize beyond Nx: a pluggable workspace probe (Turbo, Bazel, npm workspaces)

## License

MIT — see [LICENSE](./LICENSE).
