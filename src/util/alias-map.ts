// Path-alias resolver. Parses targetRepo's tsconfig.base.json `paths` block
// and produces two Maps: alias -> absolute file path, and the reverse.
//
// Why we need this:
//   - Phase 2: per-package manifests record each Pkg's alias as a field.
//   - Phase 3: ~300k import statements need O(1) alias resolution. Using
//     ts.resolveModuleName per call would cost minutes; a precomputed Map
//     is microseconds.
//
// Probed against devrev-web on 2026-05-26: 935 aliases, no comments, no
// wildcards, no multi-target arrays. The parser is defensive against all
// three (comments stripped, wildcards skipped+warned, first target taken)
// because tsconfig.base.json is hand-edited and these traits could appear
// any time.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { log } from "../log.js";

export interface AliasMap {
  // alias (e.g. "@devrev-web/data-layer/dl-utils") -> absolute file path
  aliasToFile: Map<string, string>;
  // absolute file path -> alias (reverse lookup for Phase 2)
  fileToAlias: Map<string, string>;
  // path of the tsconfig that produced this map (diagnostics)
  tsconfigPath: string;
  // total aliases successfully mapped
  count: number;
}

// Strip JSON-with-comments syntax so JSON.parse can handle real-world tsconfigs.
// Removes `// line comments` and `/* block comments */`. Trailing commas are
// NOT handled — if devrev-web ever adopts those we'll add JSON5, but per the
// 2026-05-26 probe none are present.
//
// Naive but correct enough for tsconfig: we don't try to respect comment-like
// substrings inside string literals because tsconfig values never contain `//`
// or `/*` (paths and option names are URL/identifier-shaped).
function stripJsonComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments (whole lines only)
}

interface RawTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

export async function loadAliasMap(targetRepo: string): Promise<AliasMap> {
  const tsconfigPath = join(targetRepo, "tsconfig.base.json");
  const raw = await readFile(tsconfigPath, "utf8");

  let parsed: RawTsconfig;
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as RawTsconfig;
  } catch (err) {
    throw new Error(
      `alias-map: failed to parse ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const co = parsed.compilerOptions ?? {};
  const paths = co.paths ?? {};
  // baseUrl is the anchor for relative path resolution. tsconfig defaults to ".",
  // and devrev-web confirms that. Resolve to absolute relative to the tsconfig dir.
  const baseUrl = resolve(dirname(tsconfigPath), co.baseUrl ?? ".");

  const aliasToFile = new Map<string, string>();
  const fileToAlias = new Map<string, string>();

  let skippedWildcard = 0;
  let skippedEmpty = 0;
  let multiTargetTaken = 0;

  for (const [alias, targets] of Object.entries(paths)) {
    // Wildcard aliases ("@scope/*": ["libs/*/src/index.ts"]) need pattern matching
    // at lookup time, not Map lookup. devrev-web doesn't use them; warn if any
    // appear so a future change is visible.
    if (alias.endsWith("*")) {
      skippedWildcard++;
      continue;
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      skippedEmpty++;
      continue;
    }

    if (targets.length > 1) {
      // Take the first target and note it. tsconfig semantics says the resolver
      // tries them in order; for a static map we have to pick one. The first is
      // the canonical "primary" mapping in every tsconfig convention I've seen.
      multiTargetTaken++;
    }

    const targetRel = targets[0];
    if (!targetRel) {
      skippedEmpty++;
      continue;
    }

    // Targets are relative to baseUrl. Resolve to absolute, normalized.
    const abs = resolve(baseUrl, targetRel);
    aliasToFile.set(alias, abs);
    // Reverse map: last writer wins for any rare duplicate target file.
    // (devrev-web has 0 duplicates, but if two aliases pointed at one file,
    // we'd consistently report only one of them — fine for our purposes.)
    fileToAlias.set(abs, alias);
  }

  if (skippedWildcard > 0) {
    log.warn(
      `alias-map: skipped ${skippedWildcard} wildcard alias(es) (not supported)`,
    );
  }
  if (skippedEmpty > 0) {
    log.warn(
      `alias-map: skipped ${skippedEmpty} alias(es) with empty/missing targets`,
    );
  }
  if (multiTargetTaken > 0) {
    log.warn(
      `alias-map: ${multiTargetTaken} alias(es) had multiple targets; using first`,
    );
  }
  log.info(
    `alias-map: ${aliasToFile.size} alias(es) loaded from ${tsconfigPath.replace(targetRepo + sep, "")}`,
  );

  return {
    aliasToFile,
    fileToAlias,
    tsconfigPath,
    count: aliasToFile.size,
  };
}
