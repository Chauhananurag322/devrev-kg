// Stage: nx-graph
//
// Spawns `pnpm nx graph --file=<tmp>/graph-<rand>.json` in targetRepo, parses
// the resulting JSON, and produces our normalized Pkg[].
//
// We shell out instead of importing @nx/devkit because:
//   - Couples to whichever Nx version is installed in targetRepo (no devrev-kg pin)
//   - Avoids pulling in Nx's massive dependency tree
//   - Subprocess failures (non-zero exit, invalid JSON) are easy to diagnose
//
// The output of this stage is the foundational fact set every other stage
// depends on. It tells us: what packages exist, what they depend on, where
// their source lives, what tags they have. That's all the metadata Phase 1
// repo-map.md and Phase 2 manifests need.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config, Pkg } from "../types.js";
import { log, phase } from "../log.js";

// Shape of `pnpm nx graph --file=...` output, narrowed to fields we use.
// Source of truth: probed against devrev-web on 2026-05-25 (953 nodes, no externals).
//
// Fields we deliberately ignore:
//   - data.targets (build/test command definitions — not our concern)
//   - data.$schema, data.implicitDependencies (already reflected in `dependencies`)
//   - graph.externalNodes (npm packages — `npm:*` keys, irrelevant for our index)
interface NxGraphFile {
  graph: {
    nodes: Record<string, NxNode>;
    dependencies: Record<string, NxDependency[]>;
    externalNodes?: Record<string, unknown>;
  };
}

interface NxNode {
  name: string;
  type: "app" | "lib" | "e2e";
  data: {
    root: string;
    sourceRoot?: string; // optional in Nx schema, but present for every project we care about
    projectType?: string; // "application" | "library" — redundant with type, ignored
    tags?: string[];
  };
}

interface NxDependency {
  source: string;
  target: string;
  type: "static" | "dynamic" | "implicit";
}

// Spawn `nx graph` and capture exit + stderr. We use spawn (not execFile) because:
//   - nxBin is a string like "pnpm nx" — needs shell tokenization
//   - We want to stream stderr to our own log, not buffer it
function runNxGraph(config: Config, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // nxBin examples: "pnpm nx", "npx nx". Split on whitespace into [cmd, ...args].
    const [cmd, ...nxArgs] = config.nxBin.split(/\s+/);
    if (!cmd) {
      reject(new Error(`config.nxBin is empty`));
      return;
    }
    const args = [...nxArgs, "graph", `--file=${outFile}`];

    const child = spawn(cmd, args, {
      cwd: config.targetRepo,
      // Pipe stdio so we can attach loggers; no shell needed (we already split nxBin).
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stderrTail = "";
    // Keep last ~4 KB of stderr for error reporting on failure.
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    // We don't expect useful stdout from `nx graph --file=...`, but consume it
    // anyway so the child process doesn't block on a full stdio buffer.
    child.stdout.on("data", () => {});

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `nx graph failed (exit ${code}). stderr tail:\n${stderrTail}`,
          ),
        );
      }
    });
  });
}

export async function loadNxGraph(config: Config): Promise<Pkg[]> {
  const p = phase("nx-graph");

  // Random suffix so two concurrent builds (unlikely, but possible) don't clash.
  const outFile = join(
    config.tmpDir,
    `graph-${randomBytes(6).toString("hex")}.json`,
  );

  try {
    await runNxGraph(config, outFile);

    const raw = await readFile(outFile, "utf8");
    const parsed = JSON.parse(raw) as NxGraphFile;

    // Build a Set of valid node names so we can filter dependency edges to
    // only intra-repo references. Defends against any stray `npm:*` targets
    // sneaking into the dependencies map (we saw 0 in the probe, but cheap insurance).
    const validNames = new Set(Object.keys(parsed.graph.nodes));

    const pkgs: Pkg[] = [];
    let skippedE2e = 0;
    let skippedNoSourceRoot = 0;

    for (const [name, node] of Object.entries(parsed.graph.nodes)) {
      // Skip e2e — they're test harnesses, not source we want to index.
      // Probe showed 5 of 954 nodes are e2e.
      if (node.type === "e2e") {
        skippedE2e++;
        continue;
      }

      // Defensive: a project without sourceRoot can't be AST-walked in Phase 3
      // and has no meaningful files to manifest. Should never happen for Nx
      // libs/apps but skipping is safer than emitting a half-formed Pkg.
      if (!node.data.sourceRoot) {
        skippedNoSourceRoot++;
        continue;
      }

      // Resolve `dependsOn` to the names of intra-repo packages only.
      // Drops self-loops (Nx never emits these, but cheap to guard) and any
      // edge whose target isn't a known node.
      const deps = parsed.graph.dependencies[name] ?? [];
      const dependsOn = deps
        .map((d) => d.target)
        .filter((target) => target !== name && validNames.has(target));

      pkgs.push({
        name,
        kind: node.type,
        root: node.data.root,
        sourceRoot: node.data.sourceRoot,
        tags: node.data.tags ?? [],
        dependsOn,
      });
    }

    if (skippedE2e > 0)
      log.info(`nx-graph: skipped ${skippedE2e} e2e project(s)`);
    if (skippedNoSourceRoot > 0)
      log.warn(
        `nx-graph: skipped ${skippedNoSourceRoot} project(s) without sourceRoot`,
      );

    p.end({
      apps: pkgs.filter((x) => x.kind === "app").length,
      libs: pkgs.filter((x) => x.kind === "lib").length,
      total: pkgs.length,
    });
    return pkgs;
  } finally {
    // Clean up the tmp graph file even if parsing throws.
    await rm(outFile, { force: true });
  }
}
