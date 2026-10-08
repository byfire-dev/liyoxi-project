import { assertNotInTransaction, lockRows, notifyReadOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { NoticeRecipient, NotifyDispatchDeps, NotifyQueueTask } from "./context.js";
import { currentNotificationFact, dispatchFact } from "./dispatch.js";
import { specFor } from "./registry.js";

type Task = NonNullable<Awaited<ReturnType<Tx["notificationFanout"]["findUnique"]>>>;
class LostPageClaim extends Error {}
const cursor = (task: Task) =>
  task.cursorMerchantUserId && task.cursorEntityId
    ? { merchantUserId: task.cursorMerchantUserId, entityId: task.cursorEntityId }
    : null;
const ownClaim = (task: Task) => ({
  id: task.id,
  status: "sending",
  attemptNo: task.attemptNo,
  leaseUntil: task.leaseUntil,
});

/** Pure task CAS precedes a fresh business transaction; task progress is always written last. */
export function fanoutRunner(deps: NotifyDispatchDeps) {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  function tracked<T>(run: () => Promise<T>) {
    const job = run().finally(() => pending.delete(job));
    pending.add(job);
    return job;
  }
  async function claim(id: string) {
    return deps.tx.run(async (tx) => {
      const now = deps.clock.now();
      const changed = await tx.notificationFanout.updateMany({
        where: { id, status: "pending", dueAt: { lte: now }, attemptNo: { lt: 3 } },
        data: {
          status: "sending",
          attemptNo: { increment: 1 },
          leaseUntil: new Date(now.getTime() + 60_000),
          updatedAt: now,
        },
      });
      return changed.count ? tx.notificationFanout.findUniqueOrThrow({ where: { id } }) : null;
    });
  }
  async function page(tx: Tx, task: Task) {
    if (closed) throw new LostPageClaim();
    const batch = await deps.params.get("notify.fanout.batch");
    const read = notifyReadOf(deps.assembly);
    const found = await read.read<NoticeRecipient[]>(tx, "noticeRecipientsPageForNotify", {
      after: cursor(task),
      take: batch + 1,
    });
    if (found === null) throw new TypeError("公告接收人事实未配置");
    const rows = found.slice(0, batch);
    await lockRows(
      tx,
      "merchant_user",
      rows.map((row) => row.merchantUserId),
      "share",
    );
    await lockRows(
      tx,
      "entity",
      rows.map((row) => row.entityId),
      "share",
    );
    await lockRows(
      tx,
      "entity_member",
      rows.map((row) => row.id),
      "share",
    );
    const spec = specFor(task.notifySceneKey);
    if (!spec || !["m.rule_change_notice", "m.rule_change_withdrawn"].includes(spec.sceneKey))
      throw new TypeError("公告分页场景不合法");
    const locked = await read.read<boolean>(tx, "lockSiteNoticeForNotify", task.siteNoticeId);
    const fact = locked ? await currentNotificationFact(tx, deps, spec, task.siteNoticeId) : null;
    const valid =
      fact !== null && (!spec.pendingStatus || spec.pendingStatus.includes(fact.status));
    if (valid) {
      const current = await read.read<NoticeRecipient[]>(tx, "merchantRecipientsForNotify", {
        entityId: null,
        storeId: null,
        ownerOnly: true,
        allEntities: true,
        userIds: rows.map((row) => row.merchantUserId),
      });
      if (current === null) throw new TypeError("公告成员事实未配置");
      const recipients = rows.filter((row) =>
        current.some(
          (item) =>
            item.id === row.id &&
            item.merchantUserId === row.merchantUserId &&
            item.entityId === row.entityId,
        ),
      );
      await dispatchFact(tx, deps, spec, fact, {
        node: "N0",
        recipients,
        event: {
          id: task.sourceOutboxEventId,
          type:
            spec.sceneKey === "m.rule_change_notice"
              ? "site_notice.announced"
              : "site_notice.withdrawn",
          payload: { v: 1, siteNoticeId: task.siteNoticeId },
        },
      });
    }
    if (closed) throw new LostPageClaim();
    const now = deps.clock.now(),
      last = rows.at(-1);
    const finished = !valid || found.length <= batch;
    const changed = await tx.notificationFanout.updateMany({
      where: { ...ownClaim(task), AND: [{ leaseUntil: { gt: now } }] },
      data: {
        status: valid ? (finished ? "sent" : "pending") : "cancelled",
        ...(last
          ? { cursorMerchantUserId: last.merchantUserId, cursorEntityId: last.entityId }
          : {}),
        attemptNo: 0,
        dueAt: now,
        leaseUntil: null,
        finishedAt: finished ? now : null,
        updatedAt: now,
      },
    });
    if (!changed.count) throw new LostPageClaim(); // Includes every message made by this page.
  }
  async function run(id: string) {
    if (closed) return;
    const task = await claim(id);
    if (!task) return;
    try {
      await deps.tx.run((tx) => page(tx, task));
    } catch {
      const now = deps.clock.now();
      await deps.tx.run((tx) =>
        tx.notificationFanout.updateMany({
          where: ownClaim(task),
          data: {
            status: !closed && task.attemptNo >= 3 ? "failed" : "pending",
            ...(closed ? { attemptNo: Math.max(0, task.attemptNo - 1) } : {}),
            dueAt: closed
              ? now
              : new Date(now.getTime() + (task.attemptNo === 1 ? 30_000 : 120_000)),
            leaseUntil: null,
            finishedAt: !closed && task.attemptNo >= 3 ? now : null,
            updatedAt: now,
          },
        }),
      );
    }
  }
  async function scanTasks(enqueue: (ref: NotifyQueueTask) => Promise<void>) {
    if (closed) return 0;
    const now = deps.clock.now();
    await deps.tx.run(async (tx) => {
      const expired = await tx.notificationFanout.findMany({
        where: { status: "sending", leaseUntil: { lte: now } },
        select: { id: true, attemptNo: true, leaseUntil: true },
        orderBy: { id: "asc" },
        take: 200,
      });
      for (const task of expired)
        await tx.notificationFanout.updateMany({
          where: {
            id: task.id,
            status: "sending",
            attemptNo: task.attemptNo,
            leaseUntil: task.leaseUntil,
          },
          data: {
            status: task.attemptNo >= 3 ? "failed" : "pending",
            dueAt: now,
            leaseUntil: null,
            finishedAt: task.attemptNo >= 3 ? now : null,
            updatedAt: now,
          },
        });
    });
    if (closed) return 0;
    const due = await deps.tx.run((tx) =>
      tx.notificationFanout.findMany({
        where: { status: "pending", dueAt: { lte: deps.clock.now() } },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
    );
    for (let offset = 0; offset < due.length && !closed; offset += 2)
      await Promise.all(
        due.slice(offset, offset + 2).map(async (task) => {
          try {
            await enqueue({
              fanoutId: task.id,
              pageKey: `${task.cursorMerchantUserId ?? "start"}-${task.cursorEntityId ?? "start"}-${task.dueAt.getTime()}-${task.attemptNo + 1}`,
            });
          } catch {
            await run(task.id);
          }
        }),
      );
    return due.length;
  }
  return {
    deliver: (ref: { fanoutId: string }) => {
      assertNotInTransaction("notify.fanout");
      return tracked(() => run(ref.fanoutId));
    },
    scan: (enqueue: (ref: NotifyQueueTask) => Promise<void>) => tracked(() => scanTasks(enqueue)),
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
