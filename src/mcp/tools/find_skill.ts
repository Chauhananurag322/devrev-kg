// Tool: find_skill
//
// Searches devrev-web's `.claude/skills/**/SKILL.md` set by topic. Looks at
// title (skill name), description, and trigger phrases. Returns top 5 matches
// ranked by a simple weighted score:
//
//   trigger phrase substring match: weight 4
//   title substring match:          weight 3
//   description substring match:    weight 1
//
// Lower-cased substring matching is a deliberate choice — full FTS would be
// overkill for 12 skills. If the corpus grows past ~100 skills we'd switch
// to FTS5 in Phase 3's SQLite. Today: a linear scan is microseconds.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store.js";
import type { CuratedDoc } from "../../types.js";

const inputSchema = {
  topic: z
    .string()
    .min(1)
    .describe(
      'Free-text topic, e.g. "playwright test" or "feature flag cleanup". Matches against skill name, description, and triggers.',
    ),
  limit: z.number().int().min(1).max(20).optional().default(5),
};

interface ScoredSkill {
  skill: CuratedDoc;
  score: number;
  matched: string[]; // which fields contributed to the score
}

function score(
  skill: CuratedDoc,
  q: string,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let s = 0;
  if (skill.triggers?.some((t) => t.toLowerCase().includes(q))) {
    s += 4;
    matched.push("triggers");
  }
  if (skill.title.toLowerCase().includes(q)) {
    s += 3;
    matched.push("title");
  }
  if (skill.description?.toLowerCase().includes(q)) {
    s += 1;
    matched.push("description");
  }
  return { score: s, matched };
}

export function registerFindSkill(server: McpServer, store: Store): void {
  server.registerTool(
    "find_skill",
    {
      description:
        "Find the top devrev-web skill(s) matching a topic. Searches skill name, description, and trigger phrases. Returns up to `limit` results ranked by relevance. Each result includes path, title, description, triggers, and which field(s) matched.",
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ topic, limit = 5 }) => {
      const skills = store.curated.filter((d) => d.kind === "skill");
      const q = topic.toLowerCase();

      const ranked: ScoredSkill[] = skills
        .map((skill) => {
          const { score: s, matched } = score(skill, q);
          return { skill, score: s, matched };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = ranked.map((r) => ({
        path: r.skill.path,
        title: r.skill.title,
        description: r.skill.description,
        triggers: r.skill.triggers,
        score: r.score,
        matched: r.matched,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                topic,
                total: results.length,
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
