import { invariantNow } from "../kernel/index.js";
import type { Assembly } from "../kernel/index.js";
import { findI10Violations, findI11Violations } from "../media/index.js";
import type { MediaJobs } from "../media/index.js";

/** Bind only media's runtime-dependent invariants; every other registration keeps its identity. */
export function createMediaAssembly(base: Assembly) {
  let jobs: MediaJobs | undefined;
  let closed = false;
  const current = () => {
    if (closed || !jobs) throw new TypeError("本媒体运行时尚未绑定或已经关闭");
    return jobs;
  };
  const invariants = base.invariants.map((item) =>
    item.code === "media.I10" || item.code === "media.I11"
      ? {
          ...item,
          run: (
            tx: Parameters<typeof findI10Violations>[0],
            scope: Parameters<typeof findI10Violations>[1],
            ctx: Parameters<NonNullable<typeof item.run>>[2],
          ) =>
            (item.code === "media.I10" ? findI10Violations : findI11Violations)(
              tx,
              scope,
              invariantNow(ctx),
              current(),
            ),
        }
      : item,
  );
  const index = new Map(invariants.map((item) => [item.code, item]));
  return {
    assembly: { ...base, invariants, invariant: (code: string) => index.get(code) },
    attach(service: MediaJobs) {
      if (closed || jobs) throw new TypeError("媒体运行时只能绑定一次");
      jobs = service;
    },
    close() {
      closed = true;
    },
  };
}
