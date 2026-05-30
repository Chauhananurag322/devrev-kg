// MCP prompts for devrev-kg.
//
// Prompts are the cross-client "slash command" primitive. In Claude Code,
// `repo_overview` surfaces as /mcp__devrev-kg__repo_overview — the portable,
// on-demand replacement for the SessionStart hook so NON-Claude clients
// (Cursor, Cline, Zed) can load the repo map too.
//
// A prompt returns user-role messages: the text is context the user is
// injecting into the conversation ("here is the repo, now help me"), not
// something the assistant already said.
//
// Capabilities auto-advertise: the first registerPrompt() call makes the SDK
// call registerCapabilities({ prompts: { listChanged: true } }).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";

export function registerPrompts(server: McpServer, store: Store): void {
  // repo_overview — the cross-client "load context" entry point. No args.
  server.registerPrompt(
    "repo_overview",
    {
      title: "Load repo overview",
      description:
        "Loads the monorepo map (apps, libs by domain, CLAUDE.md/skill paths) as context. Run this first when starting work in the repo.",
      // No argsSchema — this is a zero-argument prompt.
    },
    async () => {
      const md = await store.readRepoMap();
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                md ??
                "[KG repo-map.md missing — run: cd <devrev-kg> && pnpm kg:full]",
            },
          },
        ],
      };
    },
  );

  // package_context(name) — load one package's manifest as context.
  server.registerPrompt(
    "package_context",
    {
      title: "Load package context",
      description:
        "Loads one package's manifest (deps, dependents, public exports) as context.",
      // argsSchema is a RAW Zod shape, not z.object(...).
      argsSchema: {
        name: z.string().describe("Nx project name, e.g. data-layer-dl-utils"),
      },
    },
    async ({ name }) => {
      const manifest = await store.readManifest(name);
      const text = manifest
        ? `Package manifest for "${name}":\n\n` +
          JSON.stringify(manifest, null, 2) +
          `\n\nUse dependsOn/dependents to navigate, publicExports for the API surface.`
        : `Package "${name}" not found. See the kg://index resource or run the list_packages tool to discover names.`;
      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );
}
