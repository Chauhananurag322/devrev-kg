# devrev-kg

Knowledge-graph indexer + MCP server for large Nx monorepos. Designed to make Claude Code dramatically more efficient when working in repos with hundreds of packages.

Built originally for a private monorepo with **948 Nx projects, ~27k TS/TSX files, ~66k symbols, ~180k imports**. The same code works for any Nx monorepo with TypeScript path aliases.

## Why

Every fresh agent session in a large monorepo starts from zero. To answer "where does `SprintSettingsWidget` live?" or "what apps exist here?", the agent burns tokens on `ls`, `Glob`, `Grep`, and reading multiple files. Across many sessions this is repeated waste.

devrev-kg pre-indexes the repo into a small SQLite database with FTS5 and exposes it over an MCP stdio server as **9 tools, 5 resources, and 2 prompts** — so any MCP client (Cursor, Cline, Zed, Claude Code) gets the context, not just Claude Code via a session-start hook.

### Token savings (measured)

Measured against the real target monorepo (953 Nx projects, ~27k files), comparing the tokens an agent consumes to answer a question by exploring the filesystem vs. one KG call. Token counts use the standard `chars / 4` heuristic.

| Question | Without KG | With KG | Saved |
|---|---:|---:|---:|
| Locate a symbol's definition (`Grep` matches + `Read` the file) | ~1,300–2,300 tok | ~115 tok (`find_symbol`) | **~91–95%** |
| "Who imports this package?" (repo-wide grep + manual dedup) | ~22,700 tok | ~30 tok (`who_imports`) | **~99.9%** |
| "What apps exist here?" (`ls` + read several `project.json`) | ~970 tok (still partial) | ~420 tok (`list_packages`) — or **0** if the repo-map is already injected | **~57–100%** |

The repo-map injected once per session is ~8.7k tokens, but it **replaces the recurring `ls`/`Glob`/`Grep`/`Read` discovery loop** that otherwise repeats throughout a session — so it usually pays for itself within the first few lookups, and every lookup after that is near-free.

A full cold rebuild of the index runs in ~10 seconds on an M-series Mac.

> Numbers above are from this repo's measurement harness on devrev-web; exact values depend on the symbol/package and your monorepo. The pattern — one bounded KG response vs. an unbounded grep-and-read sweep — holds for any large repo.

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
│  ─ Claude Code only: hooks inject the map + per-prompt hint │
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
| `recall_memory({ topic, type?, limit? })` | Search saved cross-session memory (decisions, preferences, rationale). |

## Resources exposed by the MCP server

Resources are the **standard, cross-client** way to surface read-only context. Any MCP client (Cursor, Cline, Zed, Claude Code) auto-discovers them on connect via `resources/list` — no client-specific hook required. They use a custom `kg://` URI scheme (these are not files on your disk; the index lives under `KG_DIR`).

| Resource URI | Type | Contents |
|---|---|---|
| `kg://repo-map` | `text/markdown` | The repo overview map (apps, libs by domain, CLAUDE.md/skill paths, rules). **The primary context to load first.** |
| `kg://index` | `application/json` | Flat array of every package: `{ name, kind, root, tags, group }`. |
| `kg://last-build` | `application/json` | Build metadata (`builtAt`, `gitSha`, counts, phase) — for staleness checks. |
| `kg://memory` | `application/json` | Index of saved cross-session memory: `name`, `description`, `type`, `origin`. **No bodies** — fetch those with `recall_memory`. |
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

## No restart after a rebuild

The MCP server hot-reloads. Every tool call first stats `last-build.json`; if its
mtime moved, the server reloads `_index.json` / `curated.json` and **reopens the SQLite
handle**, then answers from the new data. Combined with the `SessionStart` rebuild
trigger, you no longer run `pnpm kg:full` by hand or restart Claude Code to consume it.

Reopening the DB is the load-bearing part, not an optimization. The build ends with an
atomic `rename(2)`, so a long-lived handle keeps pointing at the **unlinked old inode** and
serves pre-rebuild rows indefinitely — a silent wrong answer from the tool you adopted
specifically to trust over `grep`. That is what previously forced the restart.

Why stat-on-demand rather than `fs.watch`: it stays correct across the atomic swap (an
inode being replaced is precisely what `fs.watch` handles worst), needs no watcher
lifecycle or debounce, and behaves identically on every platform. A `stat` is ~10µs against
millisecond tool calls, and a 2s TTL collapses a burst of calls into one check.

Freshness is enforced by a Proxy over the server's `register*` methods
(`src/mcp/freshness.ts`), so all 16 handlers — and every future one — get it by
construction instead of by remembering to call it.

## Session continuity

`SessionEnd` appends one line per session to `<KG_DIR>/sessions.jsonl`; `SessionStart`
prints the most recent few. A new session therefore opens knowing where the last one left
off, without replaying a ~170k-token transcript.

What gets recorded is only what is **mechanically derivable and already trustworthy**:

| Field | Source |
|---|---|
| `aiTitle` | the session title **Claude Code itself generated** — the one genuinely summarized field available |
| `lastPrompt` | the final user ask, whitespace-collapsed and clipped to 240 chars |
| `gitSha`, `dirtyFiles` | target repo state at session end |
| `turns`, `toolCalls` | activity counts, used to skip trivial sessions |

**This is not a summarizer, by design.** A hook is a shell script; it cannot distill a
conversation — only a model can. Rather than fake that with heuristics, the journal records
facts and leaves judgment to the two mechanisms that have it: `recall_memory` for *why*
(written deliberately by the agent) and the index for *what* (derived from the repo). The
`<recent-sessions>` block is explicitly labelled as past state to verify, not instructions
to follow.

The journal is capped at 50 entries, re-entrant on the same `sessionId` (a resume replaces
its earlier record rather than duplicating it), written atomically because `SessionStart`
reads it, and silent on first run in a fresh repo.

## Memory integration

`recall_memory` + `kg://memory` read the **same files Claude Code's own memory tool
writes** (`~/.claude/projects/<slug>/memory/*.md`). This is a second lens on one store,
not a parallel copy — anything saved natively is immediately queryable, with no sync step
to drift out of date.

**What it adds over native recall:**

1. **Cross-project.** Native memory is keyed by CWD slug, so `-Users-admin-Office-devrev-kg`
   and `-Users-admin-Office-devrev-web` are sealed off from each other — a fact learned while
   working on the indexer is invisible while working in the monorepo it indexes. The server
   reads both stores and tags every hit with its `origin`.
2. **Index-then-fetch.** `MEMORY.md` is loaded in full every session, so native memory is a
   fixed context tax that grows with every fact saved. `kg://memory` lists descriptions only
   (~260 tokens for 4 memories); bodies arrive via `recall_memory` when relevant. The
   always-on cost stays flat as the corpus grows.

**What it deliberately does not read:** session transcripts (`<slug>/*.jsonl`). One measured
session was ~693 KB ≈ 173k tokens of verbatim tool output and dead ends — including claims
later proven wrong in that same session. Recalling those would resurrect corrected errors.
Memory files are curated claims, which is the right input for recall.

**The division of labour** — the index answers what the code *is*; memory answers *why*:

| | Index (symbols, packages, imports) | Memory |
|---|---|---|
| Answers | where / what / who imports | why we did it this way, what you prefer |
| Source | derived from the repo, stamped with `gitSha` | written deliberately, one fact per file |
| Staleness | impossible — rebuilt in ~12s on sha drift | silent; must be corrected or deleted by hand |

That asymmetry is the rule: **if a query can derive it, index it — never memorize it.** A
memorized file path survives the file being moved and then actively misleads. Rationale has
the opposite property: expensive to reconstruct, and unaffected when files move.

Memory dirs are auto-derived from `KG_DIR` and `config.json`'s `targetRepo`. Override with
`KG_MEMORY_DIRS` (colon-separated, like `PATH`) for layouts that can't be inferred. Missing
dirs are skipped silently — Claude Code prunes empty ones, so absence is normal.

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

After restart, `/mcp` lists the `kg` server with its **9 tools, 5 resources, and 2 prompts**. This is all any MCP client needs — the same `node …/server.js` + `KG_DIR` works in Cursor, Cline, and Zed.

### Optional: auto-inject the map + keep the tools in view (Claude Code only)

```bash
cd ../devrev-kg
pnpm wire    # adds hooks to your monorepo's .claude/settings.local.json
```

This installs three hooks:

| Hook | Fires | Does |
|---|---|---|
| `SessionStart` | once per session | `cat`s `repo-map.md` into context, triggers a background rebuild if the index is stale, and prints breadcrumbs from recent sessions |
| `UserPromptSubmit` | **every prompt** | prints a ~50-token reminder to prefer the KG tools over `Grep`/`Glob` |
| `SessionEnd` | session exit | journals what the session was about to `sessions.jsonl`, for the next session to read |

**Why the second one.** Registering the MCP server makes the tools *available*, but agents
reliably fall back to habitual `Grep`/`Glob` anyway. `SessionStart` fires once, so its
guidance ends up tens of thousands of tokens up-context by the middle of a session and stops
influencing behaviour. `UserPromptSubmit` re-states the routing rule on every turn, which is
what actually changes tool selection. The reminder is deliberately tiny — it points at the
tools rather than restating them, since its cost is paid on every single turn.

The repo-map also leads with an imperative routing table ("find a symbol → `find_symbol`,
not `Grep`") instead of listing tool names in a footer. Bare capability lists don't change
behaviour; instructions placed first do.

`pnpm wire` is idempotent and self-healing: it matches its own hooks by script path rather
than exact command string, so re-running after moving `outputDir` refreshes the baked-in
paths instead of stacking a duplicate that would inject the map twice.

Both hooks are a Claude-Code convenience layered on top — the resources/prompts above already
make the context available in any client without them.

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

The rebuild finishes ~10s later, and the **current** session picks it up on its next tool
call — the server reloads when it sees `last-build.json` change. No restart, and no waiting
for the next session.

To force a fresh rebuild manually: `pnpm kg:full`. No restart needed — the server picks it
up on the next tool call (see [No restart after a rebuild](#no-restart-after-a-rebuild)).

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
│   │   ├── memory.ts            Claude Code memory reader (cross-project recall)
│   │   ├── resources.ts         kg:// resources (repo-map, index, memory, package/{name})
│   │   ├── prompts.ts           repo_overview / package_context prompts
│   │   └── tools/               one file per tool
│   └── util/
│       ├── alias-map.ts         tsconfig.base.json paths parser
│       ├── fs-atomic.ts         writeFileAtomic (write→fsync→rename)
│       ├── git.ts               gitSha helpers
│       └── glob-helpers.ts      glob with always-ignore safety net
├── scripts/
│   ├── wire.mjs                 install SessionStart/UserPromptSubmit/SessionEnd hooks
│   ├── kg-hint.sh               per-prompt "use the KG" routing reminder
│   ├── session-end.sh           journal the finished session to sessions.jsonl
│   ├── recent-sessions.sh       print recent-session breadcrumbs at startup
│   └── maybe-rebuild.sh         background rebuild trigger
├── config.example.json
├── PLAN.md                      original architecture plan
└── README.md
```

## Roadmap

- True incremental `kg:affected` (currently triggers a full rebuild)
- Expose curated docs (CLAUDE.md / rules / skills) as `kg://` resources once the build writes their bodies into `KG_DIR` (currently only metadata is indexed)
- Generalize beyond Nx: a pluggable workspace probe (Turbo, Bazel, npm workspaces)

## License

MIT — see [LICENSE](./LICENSE).
