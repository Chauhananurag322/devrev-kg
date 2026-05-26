// Tool: find_symbol
//
// Locates a symbol across the indexed devrev-web codebase. Two-stage match:
//
//   1. Exact match on `symbols.name`. If we get hits, return them.
//   2. FTS5 fallback on the symbols_fts virtual table (prefix + fuzzy).
//
// Each hit returns: name, kind, package, file path, lines, signature, isExported.
// Limit defaults to 50 to keep responses bounded.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe(
      "Symbol name to look up. Tries exact match first, then FTS5 prefix/fuzzy match.",
    ),
  kind: z
    .enum([
      "function",
      "class",
      "interface",
      "type",
      "enum",
      "const",
      "component",
      "hook",
      "default",
    ])
    .optional()
    .describe("Restrict to symbols of a specific kind."),
  exported_only: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, only return symbols marked is_exported (top-level public surface).",
    ),
  package: z
    .string()
    .optional()
    .describe("Restrict matches to a single package (Nx project name)."),
  limit: z.number().int().min(1).max(200).optional().default(50),
};

type Row = {
  name: string;
  kind: string;
  is_exported: number;
  is_default: number;
  line_start: number;
  line_end: number;
  signature: string | null;
  file_path: string;
  package_name: string;
  score?: number;
};

function buildExactQuery(args: {
  name: string;
  kind?: string;
  exported_only?: boolean;
  package?: string;
}) {
  const conds: string[] = ["s.name = ?"];
  const params: unknown[] = [args.name];
  if (args.kind) {
    conds.push("s.kind = ?");
    params.push(args.kind);
  }
  if (args.exported_only) conds.push("s.is_exported = 1");
  if (args.package) {
    conds.push("p.name = ?");
    params.push(args.package);
  }
  return { conds, params };
}

// FTS5 token sanitization: wrap each whitespace-split token in double quotes
// so special chars (-, ., ", *) are treated literally. Tokens are AND-ed.
function ftsQueryFor(name: string): string {
  const tokens = name.split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function registerFindSymbol(server: McpServer, store: Store): void {
  server.registerTool(
    "find_symbol",
    {
      description:
        "Find a symbol in devrev-web by name. First tries exact match; if none, falls back to FTS5 fuzzy search across name/signature/jsdoc. Returns up to `limit` results with kind, package, file path, line numbers, and signature.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      if (!store.db) {
        return {
          content: [
            {
              type: "text",
              text: "[Phase 3 not built yet — symbols table missing. Run: cd ~/Office/devrev-kg && pnpm kg:full]",
            },
          ],
          isError: true,
        };
      }
      const limit = args.limit ?? 50;

      // 1) Exact match
      const exact = buildExactQuery(args);
      const exactRows = store.db
        .prepare(
          `SELECT s.name, s.kind, s.is_exported, s.is_default, s.line_start, s.line_end, s.signature,
                  f.path AS file_path, p.name AS package_name
             FROM symbols s
             JOIN files    f ON f.id = s.file_id
             JOIN packages p ON p.id = f.package_id
            WHERE ${exact.conds.join(" AND ")}
            LIMIT ?`,
        )
        .all(...exact.params, limit) as Row[];

      if (exactRows.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matched: "exact",
                  total: exactRows.length,
                  results: exactRows,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // 2) FTS5 fallback (name column only — full-corpus search lives in search_code)
      const ftsQuery = `name : ${ftsQueryFor(args.name)}`;
      const ftsConds: string[] = ["symbols_fts MATCH ?"];
      const ftsParams: unknown[] = [ftsQuery];
      if (args.kind) {
        ftsConds.push("s.kind = ?");
        ftsParams.push(args.kind);
      }
      if (args.exported_only) ftsConds.push("s.is_exported = 1");
      if (args.package) {
        ftsConds.push("p.name = ?");
        ftsParams.push(args.package);
      }

      let fuzzyRows: Row[] = [];
      try {
        fuzzyRows = store.db
          .prepare(
            `SELECT s.name, s.kind, s.is_exported, s.is_default, s.line_start, s.line_end, s.signature,
                    f.path AS file_path, p.name AS package_name,
                    bm25(symbols_fts) AS score
               FROM symbols_fts
               JOIN symbols  s ON s.id = symbols_fts.rowid
               JOIN files    f ON f.id = s.file_id
               JOIN packages p ON p.id = f.package_id
              WHERE ${ftsConds.join(" AND ")}
              ORDER BY score
              LIMIT ?`,
          )
          .all(...ftsParams, limit) as Row[];
      } catch (err) {
        // Malformed FTS query (bare tokens with reserved chars) — return empty.
        // Surface the original query so the user can see what was tried.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matched: "none",
                  total: 0,
                  fts_error: err instanceof Error ? err.message : String(err),
                  fts_query: ftsQuery,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                matched: fuzzyRows.length > 0 ? "fts" : "none",
                total: fuzzyRows.length,
                results: fuzzyRows,
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
