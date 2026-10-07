import type { Channel } from "./orchestrate.mjs";
export function uploadRelease(
  env: NodeJS.ProcessEnv,
  channel: Channel,
): { status: string; reason?: string; source?: string; version?: string; robot?: number };
