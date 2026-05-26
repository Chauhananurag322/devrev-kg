// Tool: list_packages
//
// Filters the in-memory _index.json by kind, tag, and/or group glob.
// Returns a compact array of { name, kind, root, group, tags }.
//
// "glob" supports a simple `*` wildcard match against group names —
// repo-map.md generates lines like
//   `mcp__kg__list_packages({ glob: "accounts/*" })`
// so we accept that exact form. The `/` is a separator inside the alias path,
// not an actual glob construct; we match by group prefix.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  kind: z.enum(["app", "lib"]).optional().describe("Filter by package kind"),
  tag: z
    .string()
    .optional()
    .describe(
      "Match if any of the package tags equals this value (exact match)",
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Group glob like "accounts/*" or "shared/*". Matches packages whose group equals the prefix before "/*". Use to drill into a domain seen in repo-map.md.',
    ),
  limit: z.number().int().min(1).max(2000).optional().default(500),
};

// Convert a "group/*"-shaped glob to a group name. Returns null if the glob
// doesn't match the supported shape (we don't pretend to support arbitrary globs).
function groupFromGlob(glob: string): string | null {
  const m = /^([^/]+)\/\*$/.exec(glob);
  return m ? m[1]! : null;
}

export function registerListPackages(server: McpServer, store: Store): void {
  server.registerTool(
    "list_packages",
    {
      description:
        'List packages from devrev-web filtered by kind, tag, or domain group. Returns a compact array, capped at `limit`. Use `glob: "<group>/*"` to drill into a specific domain (groups are listed in repo-map.md).',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const { kind, tag, glob, limit = 500 } = args;
      const groupFilter = glob ? groupFromGlob(glob) : null;
      if (glob && !groupFilter) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported glob "${glob}". Use the form "<group>/*".`,
            },
          ],
          isError: true,
        };
      }

      const filtered = store.index
        .filter((e) => (kind ? e.kind === kind : true))
        .filter((e) => (tag ? e.tags.includes(tag) : true))
        .filter((e) => (groupFilter ? e.group === groupFilter : true))
        .slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: filtered.length,
                truncated: filtered.length === limit,
                results: filtered,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
