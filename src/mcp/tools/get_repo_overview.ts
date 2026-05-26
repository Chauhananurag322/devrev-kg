// Tool: get_repo_overview
//
// Returns the contents of always/repo-map.md verbatim. Cheap fallback if the
// SessionStart hook didn't fire (e.g. Claude Code launched outside devrev-web,
// or the user is in a worktree where the hook isn't wired).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";

export function registerGetRepoOverview(server: McpServer, store: Store): void {
  server.registerTool(
    "get_repo_overview",
    {
      description:
        "Returns the always/repo-map.md content for devrev-web. Use as a fallback if SessionStart did not inject it. Includes apps, libs grouped by domain, CLAUDE.md paths, skills, and rules.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const md = await store.readRepoMap();
      if (!md) {
        return {
          content: [
            {
              type: "text",
              text: "[KG repo-map.md missing — run: cd ~/Office/devrev-kg && pnpm kg:full]",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: md }],
      };
    },
  );

  // Silence unused-import warning while keeping z available for future tools
  // declared in this file.
  void z;
}
