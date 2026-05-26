// Tiny structured logger.
//
// Two design choices worth knowing:
//
// 1. ALL output goes to stderr. The MCP server in Phase 2 will own stdout
//    for JSON-RPC traffic — any stray stdout write would corrupt the protocol
//    and Claude Code would silently drop the server. Even the build CLI logs
//    to stderr for consistency, so we never have to remember which mode we're in.
//
// 2. ANSI colors only when attached to a TTY. CI logs and `>` redirects stay
//    plain text (no escape sequence garbage in build artifacts).

type Level = "info" | "warn" | "error";

// Standard ANSI escape codes. `dim` is used for the timestamp so the level/message
// stays the visually dominant element when scanning a log.
const COLORS = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

// Captured once at import time. If you redirect stdout mid-run, that's on you.
const isTty = process.stdout.isTTY;

function emit(level: Level, msg: string): void {
  // ISO timestamp sliced to HH:MM:SS — full ISO is too noisy for an interactive run.
  const ts = new Date().toISOString().slice(11, 19);
  // padEnd(5) keeps the message column aligned across info/warn/error.
  const tag = level.toUpperCase().padEnd(5);
  if (isTty) {
    process.stderr.write(
      `${COLORS.dim}${ts}${COLORS.reset} ${COLORS[level]}${tag}${COLORS.reset} ${msg}\n`,
    );
  } else {
    process.stderr.write(`${ts} ${tag} ${msg}\n`);
  }
}

export const log = {
  info: (msg: string) => emit("info", msg),
  warn: (msg: string) => emit("warn", msg),
  error: (msg: string) => emit("error", msg),
};

export interface PhaseTimer {
  // `extra` lets a stage report counts at the end (e.g. `phase.end({ packages: 953 })`).
  // Rendered as `key=value` pairs so logs stay grep-friendly.
  end(extra?: Record<string, string | number>): void;
}

// Usage:
//   const p = phase('nx-graph');
//   ... do work ...
//   p.end({ packages: pkgs.length });
//
// Logs:  [nx-graph] start
//        [nx-graph] done in 4218ms packages=953
export function phase(name: string): PhaseTimer {
  const t0 = Date.now();
  log.info(`[${name}] start`);
  return {
    end(extra) {
      const ms = Date.now() - t0;
      const suffix = extra
        ? " " +
          Object.entries(extra)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      log.info(`[${name}] done in ${ms}ms${suffix}`);
    },
  };
}
