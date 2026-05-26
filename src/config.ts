// Loads and validates `config.json`, then materializes a BuildContext that
// every stage consumes. Two responsibilities, intentionally split:
//
//   loadConfig()    → parse + validate config.json. Synchronous logic only.
//   buildContext()  → side effects (mkdir, git sha lookup). Called once per build.
//
// Stages never re-derive paths or re-read config — they read from the context.
// One source of truth means one place to change layout.

import { readFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, BuildContext } from "./types.js";
import { ensureDir } from "./util/fs-atomic.js";
import { gitSha } from "./util/git.js";

// import.meta.url-based __dirname trick. Works under both:
//   - tsx (running from src/config.ts)
//   - node (running from dist/config.js)
// because in both cases `..` from this file's directory lands at REPO_ROOT.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Defaults applied when the config file omits the field. Only `targetRepo`
// has no default — every other field can be inferred so a fresh clone with
// a one-line config.json (just the targetRepo) works out of the box.
const DEFAULTS = {
  outputDir: join(REPO_ROOT, ".kg-output/graph"),
  nxBin: "pnpm nx",
  concurrency: 8,
  excludeGlobs: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.stories.ts",
    "**/*.stories.tsx",
    "**/*.mock.ts",
    "**/*.mock.tsx",
    "**/*.d.ts",
  ],
};

// Type-narrowing helper. With strict mode, `parsed.targetRepo` is `string | undefined`;
// this gives us a typed guard we can use in plain `if` statements.
function isDef<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

// Resolve a possibly-relative path against the kg repo root, NOT CWD.
// Means `"../my-monorepo"` in config.json points to a sibling of devrev-kg
// regardless of where the user runs pnpm kg:full from.
function resolveFromRepoRoot(p: string): string {
  return resolve(REPO_ROOT, p);
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const path = configPath ?? join(REPO_ROOT, "config.json");
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    throw new Error(
      `config.json not found at ${path}. Copy config.example.json to config.json and edit "targetRepo".`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<Config>;

  // Only targetRepo is required — every other field has a sensible default.
  if (!isDef(parsed.targetRepo)) {
    throw new Error(
      `config.json: "targetRepo" is required (${path}). Set it to the path of your Nx monorepo, e.g. "../my-monorepo".`,
    );
  }

  // Resolve relative paths against the kg repo root so the config works no
  // matter where the user invokes the CLI from.
  const targetRepo = resolveFromRepoRoot(parsed.targetRepo);
  const outputDir = parsed.outputDir
    ? resolveFromRepoRoot(parsed.outputDir)
    : DEFAULTS.outputDir;
  const tmpDir = parsed.tmpDir
    ? resolveFromRepoRoot(parsed.tmpDir)
    : join(outputDir, ".tmp");

  // Existence check on targetRepo only — outputDir doesn't have to exist yet
  // (buildContext will mkdir -p it). But targetRepo MUST exist or every stage
  // fails in confusing ways deep inside `nx graph` or a glob.
  const targetStat = await stat(targetRepo).catch(() => null);
  if (!targetStat?.isDirectory()) {
    throw new Error(
      `config.json: targetRepo does not exist or is not a directory: ${targetRepo}\n` +
        `(resolved from "${parsed.targetRepo}" relative to ${REPO_ROOT})`,
    );
  }

  return {
    targetRepo,
    outputDir,
    nxBin: parsed.nxBin ?? DEFAULTS.nxBin,
    concurrency: parsed.concurrency ?? DEFAULTS.concurrency,
    tmpDir,
    excludeGlobs: parsed.excludeGlobs ?? DEFAULTS.excludeGlobs,
  };
}

// Side-effecting setup. Creates every output directory the build will touch
// and snapshots the git sha so all stages see the same value (a `git pull`
// mid-build won't cause inconsistent metadata).
export async function buildContext(config: Config): Promise<BuildContext> {
  // mkdir -p the output tree so stages can write without checking dir existence.
  await ensureDir(config.outputDir);
  await ensureDir(config.tmpDir);
  await ensureDir(join(config.outputDir, "always")); // repo-map.md lives here
  await ensureDir(join(config.outputDir, "packages")); // per-package manifests
  await ensureDir(join(config.outputDir, "db")); // SQLite (Phase 3)

  return {
    config,
    outputs: {
      // Precomputed paths. Stages should never `path.join` these themselves.
      repoMapPath: join(config.outputDir, "always", "repo-map.md"),
      packagesDir: join(config.outputDir, "packages"),
      indexJsonPath: join(config.outputDir, "packages", "_index.json"),
      lastBuildJsonPath: join(config.outputDir, "last-build.json"),
      dbPath: join(config.outputDir, "db", "kg.sqlite"),
      dbTmpPath: join(config.outputDir, "db", "kg.sqlite.new"),
    },
    startedAt: Date.now(),
    gitSha: await gitSha(config.targetRepo),
  };
}
