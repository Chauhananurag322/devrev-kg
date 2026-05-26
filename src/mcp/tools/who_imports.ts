// Tool: who_imports
//
// Reverse import lookup. Given a target — either an Nx package name or a
// symbol name — returns the importing files, grouped by importing package.
// Used to answer "who depends on X?" without grepping.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  target: z
    .string()
    .min(1)
    .describe(
      'Either a package name (Nx project name like "data-layer-dl-utils") OR a symbol name (e.g. "useDlQuery"). Tries both.',
    ),
  type_only: z
    .boolean()
    .optional()
    .describe("If true, only return type-only imports."),
  limit: z.number().int().min(1).max(500).optional().default(50),
};

interface PackageRow {
  name: string;
}

interface ImporterRow {
  importing_package: string;
  importing_file: string;
  imported_name: string | null;
  is_type_only: number;
  module_specifier: string;
}

export function registerWhoImports(server: McpServer, store: Store): void {
  server.registerTool(
    "who_imports",
    {
      description:
        'Reverse import lookup. Given a package name or symbol name, returns the files that import it (grouped by importing package). Use to answer "who depends on X?".',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ target, type_only, limit = 50 }) => {
      if (!store.db) {
        return {
          content: [
            {
              type: "text",
              text: "[Phase 3 not built yet — imports table missing. Run: cd ~/Office/devrev-kg && pnpm kg:full]",
            },
          ],
          isError: true,
        };
      }

      // Path 1: target is a known package name.
      const pkgRow = store.db
        .prepare(`SELECT name FROM packages WHERE name = ?`)
        .get(target) as PackageRow | undefined;

      const conds: string[] = [];
      const params: unknown[] = [];

      if (pkgRow) {
        conds.push(
          `i.resolved_package_id = (SELECT id FROM packages WHERE name = ?)`,
        );
        params.push(target);
      } else {
        // Path 2: treat as a symbol name. Match imported_name OR module_specifier suffix.
        conds.push(`(i.imported_name = ? OR i.module_specifier LIKE ?)`);
        params.push(target, `%/${target}`);
      }

      if (type_only !== undefined) {
        conds.push(`i.is_type_only = ?`);
        params.push(type_only ? 1 : 0);
      }

      const rows = store.db
        .prepare(
          `SELECT p.name AS importing_package,
                  f.path AS importing_file,
                  i.imported_name,
                  i.is_type_only,
                  i.module_specifier
             FROM imports i
             JOIN files    f ON f.id = i.file_id
             JOIN packages p ON p.id = f.package_id
            WHERE ${conds.join(" AND ")}
            ORDER BY p.name, f.path
            LIMIT ?`,
        )
        .all(...params, limit) as ImporterRow[];

      // Group by importing_package
      const byPkg = new Map<string, ImporterRow[]>();
      for (const r of rows) {
        const arr = byPkg.get(r.importing_package) ?? [];
        arr.push(r);
        byPkg.set(r.importing_package, arr);
      }

      const grouped = [...byPkg.entries()].map(([pkg, imports]) => ({
        package: pkg,
        importCount: imports.length,
        examples: imports.slice(0, 5).map((i) => ({
          file: i.importing_file,
          imported: i.imported_name,
          spec: i.module_specifier,
          typeOnly: !!i.is_type_only,
        })),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                target,
                resolution: pkgRow ? "package" : "symbol",
                totalRows: rows.length,
                packageCount: grouped.length,
                groups: grouped,
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
