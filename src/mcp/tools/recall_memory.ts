// Tool: recall_memory
//
// Searches Claude Code's own cross-session memory files by topic. Same weighted
// substring ranking as find_skill (name 4 / description 3 / body 1) so the two
// rank consistently.
//
// This reads the SAME files Claude Code's native memory tool writes — it is a
// second lens, not a parallel store. Two things it adds over native recall:
//
//   1. Cross-project. Native memory is keyed by CWD slug, so a fact saved while
//      working in the indexer is invisible while working in the monorepo it
//      indexes. We read both stores and tag each hit with its origin.
//
//   2. Bodies on demand. MEMORY.md is loaded in full every session, making
//      memory a fixed context tax that grows with every fact saved. Returning
//      full bodies only for the handful of matches keeps the always-on cost flat.
//
// What this does NOT read: session transcripts (<slug>/*.jsonl). One session is
// ~170k tokens of verbatim tool output and dead ends — including claims later
// proven wrong. Recalling that would resurrect false beliefs. Memory files are
// curated claims someone decided to keep, which is the right input for recall.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";
import { scoreMemory } from "../memory.js";

// Bodies are short (a few lines each) but a broad topic can match many files.
// Truncate so one wide query can't dump the whole corpus into context — the
// point of this tool is a bounded response.
const BODY_CAP = 1200;

const inputSchema = {
  topic: z
    .string()
    .min(1)
    .describe(
      'Free-text topic, e.g. "hooks" or "token budget". Matches memory name, description, and body.',
    ),
  type: z
    .enum(["user", "feedback", "project", "reference"])
    .optional()
    .describe("Filter to one memory type."),
  limit: z.number().int().min(1).max(25).optional().default(5),
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function registerRecallMemory(server: McpServer, store: Store): void {
  server.registerTool(
    "recall_memory",
    {
      description:
        "Recall saved cross-session memory by topic — decisions, preferences, and project context that are NOT derivable from the code. Searches this project's memory AND the indexed monorepo's, so facts cross project boundaries. Use for 'why is it done this way' / 'what did we decide'; use find_symbol or search_code for anything derivable from the source.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ topic, type, limit = 5 }) => {
      // Fresh read every call: memory changes mid-session, unlike code.
      const all = await store.readMemories();
      const q = topic.toLowerCase();

      const pool = type ? all.filter((d) => d.type === type) : all;

      const ranked = pool
        .map((doc) => ({ doc, ...scoreMemory(doc, q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = ranked.map((r) => ({
        name: r.doc.name,
        description: r.doc.description,
        type: r.doc.type,
        body: truncate(r.doc.body, BODY_CAP),
        origin: r.doc.origin,
        links: r.doc.links,
        path: r.doc.path,
        score: r.score,
        matched: r.matched,
      }));

      // Distinguish "no memories exist" from "none matched" — the first means
      // nothing has been saved yet, which is actionable in a different way.
      const note =
        all.length === 0
          ? "No memory files found. Dirs searched: " +
            store.memoryDirs.join(", ") +
            ". Save facts with the memory tool; they become recallable here."
          : results.length === 0
            ? `No memory matched "${topic}" across ${all.length} memory file(s).`
            : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                topic,
                ...(type ? { type } : {}),
                totalMemories: all.length,
                total: results.length,
                ...(note ? { note } : {}),
                results,
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
