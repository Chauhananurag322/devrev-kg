// Atomic file writes. The contract: a reader either sees the OLD contents
// or the NEW contents — never a partially written file. Critical because
// the MCP server reads `_index.json` and per-package manifests at runtime
// while a rebuild may be writing them.
//
// Mechanism: write to `<path>.tmp.<rand>`, fsync the FD, then rename(2).
// rename(2) is atomic on POSIX when source and dest are on the same filesystem,
// which they always are here (same `outputDir`).

import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// `mkdir -p` equivalent. Idempotent — never throws on existing dirs.
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  // Ensure the parent dir exists; otherwise `open(tmp, 'w')` would ENOENT.
  await ensureDir(dirname(filePath));

  // 12 hex chars = 48 bits of randomness. Two concurrent writers to the
  // same logical path will not collide on the tmp filename.
  const tmp = `${filePath}.tmp.${randomBytes(6).toString("hex")}`;

  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    // fsync forces the bytes to physical storage before the rename.
    // Without this, a crash between rename and disk flush could leave
    // the file existing but empty.
    await fh.sync();
  } finally {
    // Always close the handle, even if writeFile/sync threw.
    await fh.close();
  }

  // The atomic step. Readers see either the old file or the new file,
  // never a half-written one.
  await rename(tmp, filePath);
}

// Convenience: pretty-printed JSON with trailing newline (so `cat` output
// is well-formatted and `git diff` is clean if anyone version-controls outputs).
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  pretty = true,
): Promise<void> {
  const json = pretty
    ? JSON.stringify(value, null, 2) + "\n"
    : JSON.stringify(value);
  await writeFileAtomic(filePath, json);
}

// Re-export raw writeFile for cases where atomicity isn't required
// (e.g. scratch files in tmpDir that nothing reads concurrently).
export { writeFile };
