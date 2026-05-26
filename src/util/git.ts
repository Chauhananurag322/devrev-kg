// Tiny git helpers used by build metadata (last-build.json) and `kg status`.
//
// We deliberately swallow errors and return `'unknown'` rather than throwing.
// Reason: targetRepo may briefly be in a state where `git rev-parse HEAD`
// fails (e.g. detached HEAD, empty repo, mid-rebase) — we'd rather record
// "unknown" than abort the entire indexer over a metadata field.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile (not exec) means: NO shell. The args array is passed directly
// to the kernel, so `repoPath` containing spaces or shell metacharacters
// can't inject commands. This is overkill for our single-user tool, but
// it's free safety.
const exec = promisify(execFile);

export async function gitSha(repoPath: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", repoPath, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    // Could be: not a git repo, no commits yet, mid-rebase, etc.
    // None of these are fatal for the indexer.
    return "unknown";
  }
}

// 7-char short SHA — enough to disambiguate ~1M commits, standard convention.
export async function gitShaShort(repoPath: string): Promise<string> {
  const sha = await gitSha(repoPath);
  return sha === "unknown" ? sha : sha.slice(0, 7);
}
