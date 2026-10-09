import type { DomainLoopDef } from "../loop.js";
export const mediaJobRun: DomainLoopDef = {
  name: "media_job_run",
  intervalMs: 15_000,
  run: (services, beat) => services.scanPromote(beat),
};
