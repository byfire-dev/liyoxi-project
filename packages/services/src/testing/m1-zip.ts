// The owned chain consumes the production ZIP runner; no job/file terminal facts are patched.
import assert from "node:assert/strict";
import type { Runtime } from "../runtime.js";
import type { AdjustableClock } from "./clock.js";
import { waitM1Due } from "./m1-shared.js";

export function createM1ZipDrain(input: {
  readonly runtime: Runtime;
  readonly clock: AdjustableClock;
  readonly startedAt: Date;
  readonly assertOwned: () => void;
  readonly drainEvents: () => Promise<unknown>;
  readonly background: boolean;
  readonly realTime: boolean;
  readonly signal?: AbortSignal;
}) {
  return async function drainZipPackages() {
    const { runtime, clock, assertOwned } = input;
    const deadline = performance.now() + 30_000;
    const businessStart = clock.now().getTime();
    const check = () => {
      assertOwned();
      input.signal?.throwIfAborted();
      assert.ok(performance.now() < deadline, "M1 ZIP 排空超过原三十秒观察窗");
    };
    let executed = 0;
    for (let round = 0; round < 16; round++) {
      check();
      // Background mode only observes its independent worker; drainEvents retains its
      // existing all-job and failed-job assertions and never runs a handler here.
      await input.drainEvents();
      const jobs = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: {
            kind: "zip_package",
            state: { in: ["queued", "running", "submitting", "submitted", "failed"] },
          },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          take: 129,
        }),
      );
      assert.ok(
        jobs.length <= 128 && jobs.every((job) => job.createdAt >= input.startedAt),
        "M1 ZIP 任务范围或数量越界",
      );
      assert.ok(
        jobs.every((job) => job.state !== "failed"),
        `M1 ZIP 实际制作失败：${JSON.stringify(
          jobs
            .filter((job) => job.state === "failed")
            .map((job) => ({ kind: job.kind, attemptNo: job.attemptNo, code: job.errorCode })),
        )}`,
      );
      if (!jobs.length) return;
      assert.ok(!input.background, "M1 独立 worker 返回时 ZIP 尚未收尾");
      for (const job of jobs) {
        check();
        assert.ok(job.deadlineAt > clock.now(), "M1 ZIP 不得靠过期清空活动任务");
        if (job.nextRunAt > clock.now()) {
          assert.ok(
            job.nextRunAt.getTime() - businessStart <= 30_000,
            "M1 ZIP 下次回查超出原观察窗",
          );
          if (input.realTime) await waitM1Due(job.nextRunAt, input.signal);
          else clock.advance(job.nextRunAt.getTime() - clock.now().getTime());
        }
        check();
        assert.ok(++executed <= 256, "M1 ZIP 执行次数越界");
        await runtime.media.jobs.run({ jobId: job.id });
      }
    }
    throw new Error("M1 ZIP 未在原十六轮运输窗内完成");
  };
}
