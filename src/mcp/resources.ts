// MCP resources for devrev-kg.
//
// Resources are the standard, cross-client way to expose read-only context.
// Unlike the Claude-Code-specific SessionStart hook (which cats repo-map.md
// into the session), ANY MCP client (Cursor, Cline, Zed, Claude Code) auto-
// discovers these via resources/list — so the repo context is "available for
// everyone", not just Claude Code.
//
// URI scheme: a custom `kg://` scheme. These are NOT files on the client's
// disk — the knowledge graph lives under the KG_DIR (e.g.
// ~/.claude/projects/.../graph or ./.kg-output/graph). Using `file://` would
// mislead clients into resolving the URIs against their local workspace.
//
// CRITICAL: every read callback MUST echo the requested uri.href back in
// contents[].uri, or the SDK rejects the response.
//
// Capabilities are auto-advertised: the first registerResource() call makes
// the SDK call registerCapabilities({ resources: { listChanged: true } }).
// We don't (and must not) declare them on the McpServer constructor.

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";

// Cap the per-package enumeration returned by the template's `list` callback.
// The target monorepo has ~950 projects; returning all of them floods client
// resource pickers and bloats every resources/list response. The template can
// still READ any package by name regardless of this cap — `list` is only a
// discovery hint. Full enumeration stays available via kg://index and the
// list_packages tool.
const LIST_CAP = 200;

export function registerResources(server: McpServer, store: Store): void {
  // kg://repo-map — the primary context. Mirrors get_repo_overview.ts,
  // including its fallback string when the map hasn't been built yet.
  server.registerResource(
    "repo-map",
    "kg://repo-map",
    {
      title: "Repo map",
      description:
        "Monorepo overview: apps, libs grouped by domain, CLAUDE.md paths, skills, and rules. The primary context to load before working in the repo.",
      mimeType: "text/markdown",
    },
    async (uri: URL) => {
      const md = await store.readRepoMap();
      return {
        contents: [
          {
            uri: uri.href, // MUST echo the requested URI
            mimeType: "text/markdown",
            text:
              md ??
              "[KG repo-map.md missing — run: cd <devrev-kg> && pnpm kg:full]",
          },
        ],
      };
    },
  );

  // kg://index — the flat package index, already held in memory.
  server.registerResource(
    "index",
    "kg://index",
    {
      title: "Package index",
      description:
        "Flat array of every package: { name, kind, root, tags, group }. Filter it with the list_packages tool.",
      mimeType: "application/json",
    },
    (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(store.index, null, 2),
        },
      ],
    }),
  );

  // kg://last-build — build metadata for staleness checks. May be null before
  // the first build, so guard it.
  server.registerResource(
    "last-build",
    "kg://last-build",
    {
      title: "Last build",
      description:
        "Build metadata: builtAt, gitSha, durationMs, counts, phase. Use to check whether the index is stale.",
      mimeType: "application/json",
    },
    (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            store.lastBuild ?? { error: "no build yet" },
            null,
            2,
          ),
        },
      ],
    }),
  );

  // kg://package/{name} — per-package manifest, one resource per package.
  // The `list` callback enumerates names (capped); the read callback resolves
  // any name on demand, mirroring get_package.ts including its "did you mean"
  // hint on a miss.
  server.registerResource(
    "package",
    new ResourceTemplate("kg://package/{name}", {
      // `list` is required by the ResourceTemplate ctor (pass undefined to opt
      // out — we opt in, capped). Apps first, then libs, alphabetical.
      list: () => {
        const entries = [...store.index]
          .sort((a, b) =>
            a.kind === b.kind
              ? a.name.localeCompare(b.name)
              : a.kind === "app"
                ? -1
                : 1,
          )
          .slice(0, LIST_CAP);
        return {
          resources: entries.map((e) => ({
            uri: `kg://package/${e.name}`,
            name: e.name,
            title: e.name,
            description: `${e.kind} in group "${e.group}"`,
            mimeType: "application/json",
          })),
        };
      },
      // Autocomplete the {name} variable from the index — cheap UX polish for
      // clients (Cursor/Zed) that support URI-template completion.
      complete: {
        name: (value: string) =>
          store.index
            .map((e) => e.name)
            .filter((n) => n.toLowerCase().includes(value.toLowerCase()))
            .slice(0, 20),
      },
    }),
    {
      title: "Package manifest",
      description:
        "Full manifest for one package: alias, dependsOn, dependents, entryFiles, publicExports, fileCount. The list is capped, but any package name is readable.",
      mimeType: "application/json",
    },
    async (uri: URL, variables) => {
      // Variables values are string | string[]; coerce to a single string.
      const name = String(variables.name);
      const manifest = await store.readManifest(name);
      if (!manifest) {
        const close = store.index
          .map((e) => e.name)
          .filter((n) => n.includes(name) || name.includes(n))
          .slice(0, 5);
        const hint =
          close.length > 0
            ? ` Did you mean: ${close.join(", ")}?`
            : " See the kg://index resource for all names.";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Package "${name}" not found.${hint}`,
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    },
  );
}
