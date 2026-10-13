import { invariantNow } from "../kernel/index.js";
import type { Params } from "../config/index.js";
import type { Assembly, Tx } from "../kernel/index.js";
import { findI10Violations, findI11Violations } from "../media/index.js";
import type { MediaJobs, MediaRetention } from "../media/index.js";

/** Bind only media's runtime-dependent invariants; every other registration keeps its identity. */
export function createMediaAssembly(base: Assembly) {
  let jobs: MediaJobs | undefined;
  let retention: MediaRetention | undefined;
  const currentRetention = () => {
    if (closed || !retention) throw new TypeError("媒体清除运行时尚未绑定或已关闭");
    return retention;
  };
  let closed = false;
  const current = () => {
    if (closed || !jobs) throw new TypeError("本媒体运行时尚未绑定或已经关闭");
    return jobs;
  };
  const invariants = base.invariants.map((item) =>
    item.code === "media.I8"
      ? {
          ...item,
          run: (
            tx: Parameters<MediaRetention["checkI8"]>[0],
            scope: Parameters<MediaRetention["checkI8"]>[1],
            ctx: Parameters<NonNullable<typeof item.run>>[2],
          ) => currentRetention().checkI8(tx, scope, invariantNow(ctx)),
        }
      : item.code === "media.I10" || item.code === "media.I11"
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
  const recurringJobs = base.recurringJobs.map((job) =>
    job.kind === "media.sweep"
      ? { ...job, run: (ctx: Parameters<typeof job.run>[0]) => currentRetention().sweep(ctx) }
      : job,
  );
  const recurringIndex = new Map(recurringJobs.map((job) => [job.kind, job]));
  const index = new Map(invariants.map((item) => [item.code, item]));
  return {
    assembly: {
      ...base,
      invariants,
      invariant: (code: string) => index.get(code),
      recurringJobs,
      recurringJob: (kind: string) => recurringIndex.get(kind),
    },
    attach(service: MediaJobs, retentionService?: MediaRetention) {
      if (closed || jobs) throw new TypeError("媒体运行时只能绑定一次");
      jobs = service;
      retention = retentionService;
    },
    close() {
      closed = true;
    },
  };
}

/** 每轮在事务外读取真实参数；通知仍由notify自己的公开派生处理。 */
export function mediaSweepOptions(
  params: Params,
  remindDemand: (tx: Tx, id: string) => Promise<number>,
) {
  return {
    parameters: async () => ({
      mode: await params.get("files.purge.mode"),
      maxObjects: await params.get("files.purge.max_objects"),
      maxBytes: BigInt(await params.get("files.purge.max_bytes")),
    }),
    remindDemand,
  };
}
