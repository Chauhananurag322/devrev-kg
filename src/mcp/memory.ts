// Memory reader — surfaces Claude Code's native cross-session memory through
// the KG.
//
// We deliberately read the SAME directories Claude Code's own memory tool
// writes (`~/.claude/projects/<slug>/memory/*.md`) rather than inventing a
// parallel store. There is exactly one set of memory files; this is a second
// lens onto them, not a competing copy. Anything the agent saves natively is
// immediately queryable here, with no sync step to drift.
//
// Two problems this solves:
//
//  1. Native memory is keyed by CWD SLUG. `-Users-admin-Office-devrev-kg` and
//     `-Users-admin-Office-devrev-web` are separate stores that never see each
//     other, so a fact learned while working on the indexer is invisible while
//     working in the monorepo it indexes. We read several dirs at once and tag
//     each hit with its origin, making recall cross-project.
//
//  2. `MEMORY.md` is loaded IN FULL every session, so memory is a fixed context
//     tax that grows with every fact saved. Serving bodies on demand — the same
//     index-then-fetch shape the rest of the KG uses — keeps the always-on cost
//     flat as the corpus grows.
//
// CRITICAL: unlike packages and symbols, memory is NOT read at build time and
// NOT cached at server startup. Code changes with `git HEAD`; memory changes
// mid-session, whenever the agent saves a fact. A snapshot taken at startup
// would miss everything written during the session that most needs it. These
// files are small and few, so a fresh read per call is cheap.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface MemoryDoc {
  name: string; // frontmatter `name`, falling back to the filename stem
  description: string; // frontmatter `description` — what recall matches on
  type: string; // metadata.type: user | feedback | project | reference
  body: string; // everything after the frontmatter block
  path: string; // absolute path, so callers can Read/Edit the source
  origin: string; // which memory dir this came from (the project slug)
  links: string[]; // [[wiki-links]] found in the body
}

// Claude Code derives a project's storage dir by replacing every non-alphanumeric
// character in the absolute CWD with a dash:
//   /Users/admin/Office/devrev-web -> -Users-admin-Office-devrev-web
export function slugForPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export function memoryDirForPath(absPath: string, home: string): string {
  return join(home, ".claude", "projects", slugForPath(absPath), "memory");
}

// Minimal frontmatter parser for the memory file shape:
//
//   ---
//   name: some-slug
//   description: one-liner
//   metadata:
//     type: project
//   ---
//   body...
//
// Hand-rolled rather than pulling a YAML dependency: the schema is fixed and
// three fields deep. Anything unrecognised is ignored rather than throwing —
// a malformed memory file should degrade to "no metadata", never break recall.
function parseFrontmatter(raw: string): {
  fields: Record<string, string>;
  body: string;
} {
  const fields: Record<string, string> = {};
  if (!raw.startsWith("---")) return { fields, body: raw.trim() };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fields, body: raw.trim() };

  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).trim();

  for (const line of fm.split("\n")) {
    // `key: value`, tolerating the 2-space indent under `metadata:`. We flatten
    // nesting — `metadata.type` and a bare `type` both land as `type`, which is
    // all we need and keeps the parser one pass.
    const m = /^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    // Strip YAML quoting. Descriptions containing a colon must be quoted to stay
    // valid YAML, so the quotes are common — and leaking them into output makes
    // every such description render as '"..."'.
    const trimmed = value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (trimmed.length > 0) fields[key] = trimmed;
  }

  return { fields, body };
}

function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    links.add(m[1].trim());
  }
  return [...links];
}

// Read every memory file across the given dirs. Missing dirs are skipped
// silently — a project that has never saved a memory is the normal case, not
// an error. MEMORY.md is excluded: it is the human-facing index of the other
// files, so returning it would duplicate every entry.
export async function readMemories(dirs: string[]): Promise<MemoryDoc[]> {
  const docs: MemoryDoc[] = [];

  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => null);
    if (!entries) continue;

    // The slug is the dir two levels up: <slug>/memory -> <slug>
    const origin = basename(join(dir, ".."));

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry === "MEMORY.md") continue;

      const path = join(dir, entry);
      const raw = await readFile(path, "utf8").catch(() => null);
      if (raw === null) continue;

      const { fields, body } = parseFrontmatter(raw);
      docs.push({
        name: fields.name ?? entry.replace(/\.md$/, ""),
        description: fields.description ?? "",
        type: fields.type ?? "unknown",
        body,
        path,
        origin,
        links: extractLinks(body),
      });
    }
  }

  return docs;
}

// Expand a topic into the terms we'll match on: the whole phrase, plus each
// word, plus a crudely stemmed form of each word.
//
// Pure substring matching is too brittle for recall. Searching "staleness"
// against a memory that says "goes stale" scored zero, because neither string
// contains the other — a miss a user would rightly call broken. Trimming
// common English suffixes makes "staleness"→"stale" and "decays"→"decay" hit.
//
// This is intentionally crude, not a real stemmer: over-trimming costs a
// slightly noisier match on a corpus of a few dozen files, while under-matching
// costs a silent recall failure. Cheap to make lenient, expensive to be strict.
function expandQuery(q: string): string[] {
  const terms = new Set<string>();
  const norm = q.toLowerCase().trim();
  if (norm.length === 0) return [];
  terms.add(norm);

  for (const word of norm.split(/[^a-z0-9]+/).filter(Boolean)) {
    terms.add(word);
    // Longest suffix first so "-ness" wins over "-s" on "staleness".
    for (const suffix of ["ness", "ing", "ies", "ed", "es", "s"]) {
      if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
        terms.add(word.slice(0, -suffix.length));
        break;
      }
    }
  }
  // Drop stopwords that would match nearly everything.
  for (const stop of ["the", "and", "for", "why", "how", "what", "was", "are"]) {
    terms.delete(stop);
  }
  return [...terms];
}

// Relevance score for a free-text topic, mirroring find_skill.ts's weighting so
// the two tools rank consistently:
//
//   name match:        weight 4  (the slug is the most deliberate label)
//   description match: weight 3  (written specifically to drive recall)
//   body match:        weight 1  (incidental mentions)
//
// Scored per field, not per term: a field matching three terms still scores its
// field weight once, so a long query can't outrank a precise name hit.
//
// Substring matching on a corpus this size is microseconds. If memory ever grows
// past a few hundred files this should move into the FTS5 table alongside symbols.
export function scoreMemory(
  doc: MemoryDoc,
  q: string,
): { score: number; matched: string[] } {
  const terms = expandQuery(q);
  if (terms.length === 0) return { score: 0, matched: [] };

  const hits = (haystack: string): boolean => {
    const h = haystack.toLowerCase();
    return terms.some((t) => h.includes(t));
  };

  const matched: string[] = [];
  let s = 0;
  if (hits(doc.name)) {
    s += 4;
    matched.push("name");
  }
  if (hits(doc.description)) {
    s += 3;
    matched.push("description");
  }
  if (hits(doc.body)) {
    s += 1;
    matched.push("body");
  }
  return { score: s, matched };
}
