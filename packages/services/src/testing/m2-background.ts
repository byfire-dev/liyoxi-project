// 只消费独占库本轮已到期后台任务；不拨钟、不写终态，也不靠不变量自愈。
import assert from "node:assert/strict";
import type { M1Support } from "./m1-types.js";

export function createM2Background(base: M1Support, startedAt: Date, owned: () => void) {
  return async function drainBackground() {
    const { runtime, clock } = base;
    let mediaExecuted = 0,
      notificationExecuted = 0;
    const mediaResults: { kind: string; state: string; errorCode: string | null }[] = [];
    for (let round = 0; round < 16; round++) {
      owned();
      await base.drainEvents();
      const active = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: { state: { in: ["queued", "running", "submitting", "submitted"] } },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          take: 129,
        }),
      );
      assert.ok(
        active.length <= 128 && active.every((job) => job.createdAt >= startedAt),
        "M2 媒体任务范围或数量越界",
      );
      for (const job of active) {
        if (job.nextRunAt > clock.now() && job.deadlineAt > clock.now()) continue;
        const handler = [...runtime.media.jobs.handlers.values()].find(
          (one) => one.kind === job.kind,
        );
        assert.ok(
          handler && handler.mode === job.mode && handler.validInput(job.input),
          "M2 缺已登记媒体处理器",
        );
        assert.ok(++mediaExecuted <= 256, "M2 媒体执行次数越界");
        if (job.deadlineAt <= clock.now())
          await runtime.tx.run((tx) => runtime.media.jobs.expire(tx, job.id, clock.now()));
        else await runtime.media.jobs.run({ jobId: job.id });
        const actual = await runtime.tx.run((tx) =>
          tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } }),
        );
        assert.ok(
          [
            "queued",
            "running",
            "submitting",
            "submitted",
            "succeeded",
            "failed",
            "canceled",
          ].includes(actual.state),
          "M2 未知媒体终态",
        );
        mediaResults.push({ kind: actual.kind, state: actual.state, errorCode: actual.errorCode });
      }
      const scope = await runtime.tx.run(async (tx) => ({
        deliveryCount: await tx.notificationDelivery.count(),
        fanoutCount: await tx.notificationFanout.count(),
        foreignDelivery: await tx.notificationDelivery.count({
          where: { createdAt: { lt: startedAt } },
        }),
        foreignFanout: await tx.notificationFanout.count({
          where: { createdAt: { lt: startedAt } },
        }),
      }));
      assert.ok(
        scope.deliveryCount + scope.fanoutCount <= 512 &&
          scope.foreignDelivery === 0 &&
          scope.foreignFanout === 0,
        "M2 通知范围或数量越界",
      );
      await runtime.notify.scan(async (ref) => {
        assert.ok(++notificationExecuted <= 512, "M2 通知执行次数越界");
        await runtime.notify.deliver(ref);
      });
      // scan 在 enqueue 失败时会自行 deliver；因此也在返回处核总执行上界。
      assert.ok(notificationExecuted <= 512, "M2 通知执行次数越界");
      await base.drainEvents();
      const remaining = await runtime.tx.run(async (tx) => ({
        media: await tx.mediaJob.count({
          where: {
            state: { in: ["queued", "running", "submitting", "submitted"] },
            OR: [{ nextRunAt: { lte: clock.now() } }, { deadlineAt: { lte: clock.now() } }],
          },
        }),
        delivery: await tx.notificationDelivery.count({
          where: {
            OR: [
              { status: "pending", dueAt: { lte: clock.now() } },
              { status: "sending", leaseUntil: { lte: clock.now() } },
            ],
          },
        }),
        fanout: await tx.notificationFanout.count({
          where: {
            OR: [
              { status: "pending", dueAt: { lte: clock.now() } },
              { status: "sending", leaseUntil: { lte: clock.now() } },
            ],
          },
        }),
      }));
      if (remaining.media + remaining.delivery + remaining.fanout === 0)
        return { mediaExecuted, notificationExecuted, mediaResults };
    }
    throw new Error("M2 后台任务超过16轮，拒绝把未收尾视为完成");
  };
}
