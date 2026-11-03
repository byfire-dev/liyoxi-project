import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../dist/tmp/", import.meta.url));

/** Only the orchestrator's current-checkout, private run directory may supply a cache. */
export function liveCompileCacheEnv(source) {
  if (source.NODE_V8_COVERAGE !== undefined) return {};
  const context = source.LYX_ADMIN_LIVE_CONTEXT;
  const cache = source.NODE_COMPILE_CACHE;
  if (typeof context !== "string" || typeof cache !== "string") return {};
  const directory = dirname(context);
  if (
    !/^admin-live-[0-9a-f]{16}$/.test(basename(directory)) ||
    directory !== resolve(root, basename(directory)) ||
    context !== join(directory, "context.json") ||
    cache !== join(directory, "node-compile-cache")
  )
    return {};
  try {
    for (const [path, isDirectory, mode] of [
      [directory, true, 0o700],
      [context, false, 0o600],
      [cache, true, 0o700],
    ]) {
      const stat = lstatSync(path);
      if (
        realpathSync(path) !== path ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== mode ||
        !(isDirectory ? stat.isDirectory() : stat.isFile())
      )
        return {};
    }
    return { NODE_COMPILE_CACHE: cache };
  } catch {
    // Compilation is optional; missing, stale or foreign paths never reach the child.
    return {};
  }
}
