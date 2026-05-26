// Tool: search_code
//
// Full-text search over the symbols_fts table. Searches name + signature + jsdoc.
// Multi-token queries are AND'd. Special chars are quoted to keep the query
// literal-friendly. Top 30 results by bm25 score by default.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Free-text query. Multiple words are AND-ed. Searches symbol name, signature, and jsdoc. " +
        "Use to find code by partial name or by terms appearing in the docstring.",
    ),
  package: z
    .string()
    .optional()
    .describe("Restrict to a single package (Nx project name)."),
  limit: z.number().int().min(1).max(200).optional().default(30),
};

type Row = {
  name: string;
  kind: string;
  is_exported: number;
  line_start: number;
  signature: string | null;
  jsdoc: string | null;
  file_path: string;
  package_name: string;
  score: number;
};

// Same FTS sanitization as find_symbol: quote each token, AND them.
function sanitize(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function registerSearchCode(server: McpServer, store: Store): void {
  server.registerTool(
    "search_code",
    {
      description:
        'Full-text search across all symbols (name + signature + jsdoc). Top results ranked by FTS5 bm25. Use for queries that combine partial names with context terms (e.g. "useDl mutation", "sprint widget").',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, package: pkg, limit = 30 }) => {
      if (!store.db) {
        return {
          content: [
            {
              type: "text",
              text: "[Phase 3 not built yet — symbols_fts missing. Run: cd ~/Office/devrev-kg && pnpm kg:full]",
            },
          ],
          isError: true,
        };
      }

      const ftsQuery = sanitize(query);
      const conds: string[] = ["symbols_fts MATCH ?"];
      const params: unknown[] = [ftsQuery];
      if (pkg) {
        conds.push("p.name = ?");
        params.push(pkg);
      }

      try {
        const rows = store.db
          .prepare(
            `SELECT s.name, s.kind, s.is_exported, s.line_start, s.signature, s.jsdoc,
                    f.path AS file_path, p.name AS package_name,
                    bm25(symbols_fts) AS score
               FROM symbols_fts
               JOIN symbols  s ON s.id = symbols_fts.rowid
               JOIN files    f ON f.id = s.file_id
               JOIN packages p ON p.id = f.package_id
              WHERE ${conds.join(" AND ")}
              ORDER BY score
              LIMIT ?`,
          )
          .all(...params, limit) as Row[];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  fts_query: ftsQuery,
                  total: rows.length,
                  results: rows,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  fts_query: ftsQuery,
                  total: 0,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
