// Tool: get_package
//
// Returns the full Manifest for a single package (read from
// <KG>/packages/<name>.json). Includes dependsOn / dependents / publicExports /
// alias / claudeMd / fileCount.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe(
      'Nx project name (e.g. "data-layer-dl-utils"). Must match a name from list_packages or _index.json.',
    ),
};

export function registerGetPackage(server: McpServer, store: Store): void {
  server.registerTool(
    "get_package",
    {
      description:
        "Returns the full manifest for a single devrev-web package: alias, root/sourceRoot, tags, dependsOn[], dependents[], entryFiles[], publicExports[], fileCount, and CLAUDE.md path if present.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ name }) => {
      const manifest = await store.readManifest(name);
      if (!manifest) {
        // Helpful suggestion: did the user typo a known name?
        const close = store.index
          .map((e) => e.name)
          .filter((n) => n.includes(name) || name.includes(n))
          .slice(0, 5);
        const hint =
          close.length > 0
            ? ` Did you mean: ${close.join(", ")}?`
            : " Use list_packages to discover names.";
        return {
          content: [
            { type: "text", text: `Package "${name}" not found.${hint}` },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
      };
    },
  );
}
