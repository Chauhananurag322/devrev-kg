// Thin wrapper around the `glob` package that bakes in a list of "always ignore"
// directories. Every consumer (curated stage, exports stage, AST walker) gets
// these excludes for free, so we don't accidentally walk into node_modules or
// the Nx cache.
//
// Per-call `ignore` EXTENDS this list, never replaces. That keeps the safety
// net intact — you can't accidentally drop the always-ignore list by passing
// a custom `ignore: [...]`.

import { glob } from "glob";

const ALWAYS_IGNORE = [
  "**/node_modules/**", // never walk into installed packages
  "**/dist/**", // build outputs
  "**/.next/**", // Next.js cache
  "**/.nx/**", // Nx cache (computation cache + daemon files)
  "**/.git/**", // git internals
];

export interface GlobOpts {
  cwd: string; // anchor for relative patterns
  patterns: string | string[];
  ignore?: string[]; // appended to ALWAYS_IGNORE
  absolute?: boolean; // return absolute paths (default: false → relative to cwd)
  nodir?: boolean; // exclude directories from results (default: true)
}

export async function globFiles(opts: GlobOpts): Promise<string[]> {
  return glob(opts.patterns, {
    cwd: opts.cwd,
    ignore: [...ALWAYS_IGNORE, ...(opts.ignore ?? [])],
    absolute: opts.absolute ?? false,
    nodir: opts.nodir ?? true,
    // We never want hidden files/dirs in source enumeration. devrev-web's
    // CLAUDE.md is in `.claude/` — but we resolve those via explicit paths,
    // not glob, so this default is safe.
    dot: false,
  });
}
