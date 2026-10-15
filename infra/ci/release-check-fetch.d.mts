import type { selectReleaseChecks } from "./release-checks.mjs";

export function fetchReleaseChecks(
  env?: NodeJS.ProcessEnv,
  request?: typeof fetch,
): Promise<ReturnType<typeof selectReleaseChecks>>;
