// Tool: get_dependency_path
//
// BFS over package_deps to find the shortest dependency chain from one
// package to another. Returns the chain or null if unreachable.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  from: z.string().min(1).describe("Source package (Nx project name)."),
  to: z.string().min(1).describe("Target package (Nx project name)."),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(8)
    .describe("Max BFS depth."),
};

interface DepRow {
  from_pkg: string;
  to_pkg: string;
}

export function registerGetDependencyPath(
  server: McpServer,
  store: Store,
): void {
  server.registerTool(
    "get_dependency_path",
    {
      description:
        "Find the shortest import-graph path from package A to package B (BFS over package_deps). Returns the chain of packages, or null if B is not reachable from A.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, max_depth = 8 }) => {
      if (!store.db) {
        return {
          content: [
            {
              type: "text",
              text: "[Phase 3 not built yet — package_deps missing. Run: cd ~/Office/devrev-kg && pnpm kg:full]",
            },
          ],
          isError: true,
        };
      }

      // Sanity: do both packages exist?
      const fromExists = store.indexByName.has(from);
      const toExists = store.indexByName.has(to);
      if (!fromExists || !toExists) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  from,
                  to,
                  found: false,
                  reason: !fromExists
                    ? `from package "${from}" not found`
                    : `to package "${to}" not found`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (from === to) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { from, to, found: true, path: [from], depth: 0 },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Load all edges into memory once. ~10k edges max for devrev-web; trivial.
      const edges = store.db
        .prepare(
          `SELECT pf.name AS from_pkg, pt.name AS to_pkg
             FROM package_deps d
             JOIN packages pf ON pf.id = d.from_package_id
             JOIN packages pt ON pt.id = d.to_package_id`,
        )
        .all() as DepRow[];

      // Build adjacency list
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        const arr = adj.get(e.from_pkg) ?? [];
        arr.push(e.to_pkg);
        adj.set(e.from_pkg, arr);
      }

      // BFS
      const visited = new Set<string>([from]);
      const parent = new Map<string, string>();
      const queue: Array<{ node: string; depth: number }> = [
        { node: from, depth: 0 },
      ];
      let found = false;

      while (queue.length > 0) {
        const { node, depth } = queue.shift()!;
        if (depth >= max_depth) continue;
        const neighbors = adj.get(node) ?? [];
        for (const n of neighbors) {
          if (visited.has(n)) continue;
          visited.add(n);
          parent.set(n, node);
          if (n === to) {
            found = true;
            break;
          }
          queue.push({ node: n, depth: depth + 1 });
        }
        if (found) break;
      }

      if (!found) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  from,
                  to,
                  found: false,
                  searchedDepth: max_depth,
                  reason: "no path within max_depth",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Reconstruct path
      const path: string[] = [to];
      let cur = to;
      while (cur !== from) {
        const prev = parent.get(cur);
        if (!prev) break;
        path.unshift(prev);
        cur = prev;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { from, to, found: true, path, depth: path.length - 1 },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
