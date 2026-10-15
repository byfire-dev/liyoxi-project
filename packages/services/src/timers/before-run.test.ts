import { beforeAll, it, expect } from "vitest";
import { assertNotInTransaction } from "../kernel/index.js";
import { SAMPLE_TIMER_KINDS, useTestDatabase, workerSampleCounts } from "../testing/index.js";
import { runTimer, scanDue } from "./index.js";
import type { ScanDeps } from "./index.js";
import { workerTimers } from "./__fixtures__/worker.js";

const db = useTestDatabase("timer_prepare");
const t = workerTimers();
beforeAll(async () => t.attach(await db.prisma()));

it("队列与关键类降级在事务外准备；失败原退避，准备期间取消不再执行业务", async () => {
  const prisma = await db.prisma();
  const { plain, revivable } = SAMPLE_TIMER_KINDS;
  const before = await workerSampleCounts(prisma);
  const prepared: string[] = [];
  let fail = false;
  const deps: ScanDeps = {
    ...t.deps,
    beforeRun: async (ref) => {
      assertNotInTransaction("timer preparation external IO");
      expect(await t.state(ref.timerId)).toMatchObject({
        status: "dispatched",
        dispatchNo: ref.dispatchNo,
      });
      if (fail) throw new Error("本地外部结果暂不可用");
      prepared.push(ref.timerId);
    },
  };
  const queued = await t.arm(plain);
  expect(await runTimer(deps, await t.claim(queued.id))).toBe("fired");
  expect(prepared).toEqual([queued.id]);
  expect((await workerSampleCounts(prisma))[plain]).toBe(before[plain] + 1);

  const failed = await t.arm(plain);
  fail = true;
  expect(await runTimer(deps, await t.claim(failed.id))).toBe("retry");
  expect(await t.state(failed.id)).toMatchObject({
    status: "scheduled",
    attempts: 1,
    retrySec: 60,
    fired: false,
  });
  expect((await workerSampleCounts(prisma))[plain]).toBe(before[plain] + 1);
  fail = false;
  await t.hasten(failed.id);
  expect(await runTimer(deps, await t.claim(failed.id))).toBe("fired");
  expect((await workerSampleCounts(prisma))[plain]).toBe(before[plain] + 2);

  const inline = await t.arm(revivable);
  t.channel.down = true;
  expect(await scanDue(deps)).toMatchObject({ claimed: 1, inProcess: 1, enqueued: 0 });
  expect(prepared).toContain(inline.id);
  expect(await t.state(inline.id)).toMatchObject({ status: "fired", attempts: 0 });
  expect((await workerSampleCounts(prisma))[revivable]).toBe(before[revivable] + 1);

  const cancelled = await t.arm(plain);
  expect(
    await runTimer(
      {
        ...deps,
        beforeRun: async () => {
          assertNotInTransaction("timer preparation cancellation");
          await t.deps.tx.run((tx) => t.timers.cancel(tx, { subject: cancelled.subject }));
        },
      },
      await t.claim(cancelled.id),
    ),
  ).toBe("stale");
  expect(await t.state(cancelled.id)).toMatchObject({ status: "cancelled", fired: false });
  expect((await workerSampleCounts(prisma))[plain]).toBe(before[plain] + 2);
});
