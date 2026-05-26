# devrev-kg

Knowledge-graph indexer + MCP server for large Nx monorepos. Designed to make Claude Code dramatically more efficient when working in repos with hundreds of packages.

Built originally for a private monorepo with **948 Nx projects, ~27k TS/TSX files, ~66k symbols, ~180k imports**. The same code works for any Nx monorepo with TypeScript path aliases.

## Why

Every fresh Claude Code session in a large monorepo starts from zero. To answer "where does `SprintSettingsWidget` live?" or "what apps exist here?", Claude burns tokens on `ls`, `Glob`, `Grep`, and reading multiple files. Across many sessions this is repeated waste.

devrev-kg pre-indexes the repo into a small SQLite database with FTS5 and exposes 8 tools over an MCP stdio server, plus a session-start markdown overview. Net effect:

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
│  Claude Code (running in your monorepo)                     │
│  ─ SessionStart hook injects repo-map.md (~6k tokens)       │
│  ─ MCP tools available as mcp__kg__*                        │
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

After the first build:

```bash
# Wire up Claude Code (registers SessionStart hooks in your target repo)
pnpm wire

# Register the MCP server. Run from inside your target repo:
cd ../my-monorepo
claude mcp add kg --scope local \
  --env KG_DIR=$(pwd)/../devrev-kg/.kg-output/graph \
  -- node $(pwd)/../devrev-kg/dist/mcp/server.js

# Restart Claude Code
```

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
- Optional Cursor / Cline / other-tool MCP integrations
- Generalize beyond Nx: a pluggable workspace probe (Turbo, Bazel, npm workspaces)

## License

MIT — see [LICENSE](./LICENSE).
