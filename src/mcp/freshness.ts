// Freshness interceptor.
//
// Every tool/resource/prompt handler must call store.ensureFresh() before it
// touches store data, or it risks serving pre-rebuild results — and in the
// SQLite case that failure is silent and permanent (see the HOT RELOAD note in
// store.ts).
//
// Rather than adding that call to all 16 handlers and trusting every future one
// to remember, we wrap the McpServer's three register* methods once. Handlers
// stay ignorant of reloading, and a newly added tool gets freshness by
// construction rather than by review.
//
// The wrapper is a Proxy, not a subclass: McpServer's register* methods are
// heavily overloaded, and re-declaring those signatures would mean maintaining a
// parallel copy of the SDK's types. A Proxy passes arguments through untouched.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";

// The handler is always the LAST function argument in every register* overload
// (registerTool(name, config, cb), registerResource(name, uri|template, meta, cb),
// registerPrompt(name, config, cb)). We wrap the final function argument and
// leave the rest as-is.
function wrapLastFunctionArg(args: unknown[], store: Store): unknown[] {
  let idx = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === "function") {
      idx = i;
      break;
    }
  }
  if (idx === -1) return args;

  const original = args[idx] as (...a: unknown[]) => unknown;
  const wrapped = async (...handlerArgs: unknown[]) => {
    // Never let a freshness check break a call that would otherwise succeed:
    // worst case we serve the previous snapshot, which is strictly better than
    // erroring. Reload failures are already swallowed inside load().
    try {
      await store.ensureFresh();
    } catch {
      // fall through to the handler with the existing snapshot
    }
    return original(...handlerArgs);
  };

  const next = [...args];
  next[idx] = wrapped;
  return next;
}

const INTERCEPTED = new Set([
  "registerTool",
  "registerResource",
  "registerPrompt",
]);

// Returns a Proxy over `server` that auto-wraps handlers passed to register*.
// Register through this, and freshness is guaranteed.
export function withFreshness(server: McpServer, store: Store): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && INTERCEPTED.has(prop) && typeof value === "function") {
        return (...args: unknown[]) =>
          (value as (...a: unknown[]) => unknown).apply(
            target,
            wrapLastFunctionArg(args, store),
          );
      }
      // Preserve `this` for every other method (connect, etc.).
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
