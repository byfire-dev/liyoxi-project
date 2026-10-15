// Background mode observes durable facts only. No claim, enqueue, handler or terminal-state writes.
import { setTimeout as pause } from "node:timers/promises";
import { MEDIA_JOB_KIND } from "@liyoxi/contract";
import { EVENTS, JOBS, TIMERS } from "@liyoxi/contract/registry";
import type { Tx } from "../kernel/index.js";
import type { Runtime } from "../runtime.js";
import type { M1MediaScope, M1OrderScope } from "./m1-types.js";

export async function waitM1Worker<T>(
  read: () => Promise<T | null>,
  assertOwned: () => void,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + 30_000;
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  for (;;) {
    assertOwned();
    bounded.throwIfAborted();
    const value = await new Promise<T | null>((resolve, reject) => {
      const abort = () => reject(bounded.reason);
      bounded.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(read)
        .then(resolve, reject)
        .finally(() => bounded.removeEventListener("abort", abort));
    });
    assertOwned();
    bounded.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("M1 后台worker观察超过三十秒");
    if (value !== null) return value;
    await pause(100, undefined, { signal: bounded });
  }
}

/** Full owned DB, bounded distinct kinds. Unknown rows cannot silently disappear via relay. */
export async function readM1WorkerBacklog(
  tx: Pick<Tx, "outboxEvent" | "outboxDelivery" | "timer" | "mediaJob">,
  now: Date,
) {
  const [events, deliveries, timers, jobs] = await Promise.all([
    tx.outboxEvent.groupBy({ by: ["eventType"], take: 512, orderBy: { eventType: "asc" } }),
    tx.outboxDelivery.groupBy({ by: ["subscriber"], take: 512, orderBy: { subscriber: "asc" } }),
    tx.timer.groupBy({ by: ["kind"], take: 512, orderBy: { kind: "asc" } }),
    tx.mediaJob.groupBy({ by: ["kind"], take: 512, orderBy: { kind: "asc" } }),
  ]);
  const kinds = {
    events: events.map((row) => row.eventType),
    subscribers: deliveries.map((row) => row.subscriber),
    timers: timers.map((row) => row.kind),
    media: jobs.map((row) => row.kind),
  };
  const [
    unpublished,
    unsettled,
    deadDeliveries,
    dueTimers,
    deadTimers,
    mediaPending,
    mediaFailed,
    published,
    consumed,
  ] = await Promise.all([
    tx.outboxEvent.count({ where: { publishedAt: null } }),
    tx.outboxDelivery.count({ where: { status: { not: "done" } } }),
    tx.outboxDelivery.count({ where: { status: "dead" } }),
    tx.timer.count({
      where: {
        OR: [
          { status: "dispatched" },
          { status: "scheduled", retryAt: { lte: now } },
          { status: "scheduled", retryAt: null, fireAt: { lte: now } },
        ],
      },
    }),
    tx.timer.count({ where: { status: "failed" } }),
    tx.mediaJob.count({
      where: { state: { in: ["queued", "running", "submitting", "submitted"] } },
    }),
    tx.mediaJob.count({ where: { state: "failed" } }),
    tx.outboxEvent.count({ where: { publishedAt: { not: null } } }),
    tx.outboxDelivery.count({ where: { status: "done" } }),
  ]);
  return {
    kinds,
    unpublished,
    unsettled,
    deadDeliveries,
    dueTimers,
    deadTimers,
    mediaPending,
    mediaFailed,
    published,
    consumed,
  };
}
export type M1WorkerBacklog = Awaited<ReturnType<typeof readM1WorkerBacklog>>;

export const m1WorkerSettled = (row: M1WorkerBacklog) =>
  row.unpublished + row.unsettled + row.dueTimers + row.mediaPending === 0;

export function assertM1WorkerKnown(backlog: M1WorkerBacklog, subscribers: readonly string[]) {
  const known: Record<keyof M1WorkerBacklog["kinds"], readonly string[]> = {
    events: EVENTS.map((row) => row.name),
    subscribers,
    timers: [...TIMERS, ...JOBS].map((row) => row.kind),
    media: MEDIA_JOB_KIND.values,
  };
  for (const key of ["events", "subscribers", "timers", "media"] as const)
    if (
      backlog.kinds[key].length >= 512 ||
      backlog.kinds[key].some((value) => !known[key].includes(value))
    )
      throw new Error("M1 后台worker存在未知类型或种类扫描不完整");
  if (backlog.deadDeliveries || backlog.deadTimers || backlog.mediaFailed)
    throw new Error("M1 后台worker存在死信或失败任务");
}

export function m1WorkerObserver(
  runtime: Runtime,
  assertOwned: () => void,
  signal?: AbortSignal,
  resumeTimerScan?: () => Promise<void>,
) {
  const subscribers = runtime.events.subscribers.all.map((row) => row.name);
  const readBacklog = async () => {
    assertOwned();
    const result = await runtime.tx.run((tx) => readM1WorkerBacklog(tx, runtime.clock.now()));
    assertM1WorkerKnown(result, subscribers);
    return result;
  };
  const wait = <T>(read: () => Promise<T | null>) => waitM1Worker(read, assertOwned, signal);
  async function orderTimer(scope: M1OrderScope) {
    assertOwned();
    return runtime.tx.run(async (tx) => {
      const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: scope.orderId } });
      if (
        order.storeId !== scope.storeId ||
        order.entityId !== scope.entityId ||
        order.placedByUserId !== scope.merchantUserId
      )
        throw new Error("M1 后台timer不属于本轮订单");
      const timer = await tx.timer.findFirstOrThrow({
        where: {
          kind: "order.start",
          subjectType: "drama_order",
          subjectId: order.id,
        },
      });
      return { timerId: timer.id, fireAt: timer.fireAt };
    });
  }
  return {
    readBacklog,
    orderTimer,
    async runDueTimer(scope: M1OrderScope, timerId: string) {
      const expected = await orderTimer(scope);
      if (expected.timerId !== timerId) throw new Error("M1 后台timer目标不匹配");
      await resumeTimerScan?.(); // called only after the original runner's pending_start/held assertions
      return wait(async () => {
        await readBacklog();
        const row = await runtime.tx.run((tx) =>
          tx.timer.findUniqueOrThrow({ where: { id: timerId } }),
        );
        if (["failed", "cancelled", "skipped"].includes(row.status))
          throw new Error("M1 后台order.start未实际完成");
        if (row.fireAt.getTime() !== expected.fireAt.getTime())
          throw new Error("M1 后台timer业务时刻被改变");
        return row.status === "fired" && row.dispatchNo > 0
          ? {
              outcome: "fired" as const,
              dispatchNo: row.dispatchNo,
              fireAt: row.fireAt,
              businessNow: runtime.clock.now(),
            }
          : null;
      });
    },
    async drainEvents() {
      const before = await readBacklog();
      const after = await wait(async () => {
        const row = await readBacklog();
        return m1WorkerSettled(row) ? row : null;
      });
      return {
        expanded: Math.max(0, after.published - before.published),
        consumed: Math.max(0, after.consumed - before.consumed),
      };
    },
    async promote(fileId: string) {
      await wait(async () => {
        await readBacklog();
        const file = await runtime.tx.run((tx) =>
          tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }),
        );
        if (["rejected", "expired", "deleted", "deleting"].includes(file.status))
          throw new Error("M1 后台文件入库明确失败");
        if (file.status !== "stored") return null;
        const bucket = file.bucket;
        if (bucket !== "secure" && bucket !== "asset" && bucket !== "media" && bucket !== "pub")
          throw new Error("M1 后台文件桶不合法");
        const head = await runtime.providers.storage.head({
          bucket,
          key: file.objectKey,
          signal,
        });
        if (
          !head.ok ||
          !head.value.exists ||
          !file.etag ||
          head.value.etag !== file.etag ||
          BigInt(head.value.size) !== file.sizeBytes
        )
          throw new Error("M1 后台文件实际对象不匹配");
        return true;
      });
    },
    async finishProduction(fileId: string, scope: M1MediaScope) {
      await wait(async () => {
        await readBacklog();
        return runtime.tx.run(async (tx) => {
          const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
          const record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId } });
          const ticket = await tx.deliveryTicket.findUniqueOrThrow({
            where: { id: scope.deliveryTicketId },
          });
          if (
            file.entityId !== scope.entityId ||
            file.storeId !== scope.storeId ||
            file.category !== scope.category ||
            file.uploadActorId !== scope.uploaderId ||
            record.orderItemId !== scope.orderItemId ||
            record.episodeNo !== scope.episodeNo ||
            ticket.dramaOrderId !== scope.orderId ||
            ticket.orderItemId !== scope.orderItemId
          )
            throw new Error("M1 后台制作目标不属于本轮交付");
          const facts = await runtime.media.deliveryProductionFacts(tx, fileId);
          return facts.ready && (scope.category !== "sample_video" || facts.playable) ? true : null;
        });
      });
    },
    waitForBatch: (read: () => Promise<boolean>) =>
      wait(async () => {
        await readBacklog();
        return (await read()) ? true : null;
      }).then(() => undefined),
  };
}
