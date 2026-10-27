import type { PrismaClient } from "@liyoxi/db";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { alertsOf, assertNotInTransaction, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  createRecordingPorts,
  createSampleEvents,
  createWorkerSample,
  deliverRepeatedly,
  sampleSystemContext,
  useTestDatabase,
  WORKER_SAMPLE_SUBSCRIBERS,
  workerSampleCounts,
} from "../testing/index.js";
import type { SampleEvents } from "../testing/index.js";
import { barrier, openClient, SLOW } from "./__fixtures__/db.js";
import {
  claimDeliveries,
  consumeDelivery,
  DELIVERY_BACKOFF_SEC,
  DELIVERY_MAX_ATTEMPTS,
  deliveryJobId,
  dispatchDue,
  OUTBOX_QUEUE,
} from "./dispatch.js";
import type { ClaimedDelivery, DeliveryRef, DispatchDeps } from "./dispatch.js";

// 任务书 第 7 节验收 7（退避与死信、不认识的事件类型）；另：派发序号不符不落结果、重复送达副作用一次、
// 租约过期的两种记法、入队失败的三条出路、两个实例同时认领（甲类的并发测试）、失败序列的性质测试。
// 时间都是数据库时间：退避量用同一条语句写下的 next_attempt_at − updated_at 量，不看墙上钟。

const { critical, plain } = WORKER_SAMPLE_SUBSCRIBERS;
const EVENT = "lyxtest.order.placed";

const db = useTestDatabase("services");
const workers = createWorkerSample();
const ports = createRecordingPorts();
/** 假的执行通道：只记下入队的任务，或按用例的安排报“不可用” */
const channel = {
  down: false,
  downMs: 0,
  jobs: [] as Array<{ queue: string; jobId: string; data: unknown }>,
  async enqueue(queue: string, jobId: string, data: unknown): Promise<void> {
    if (this.down) throw new Error("样例：Redis 不可用");
    this.jobs.push({ queue, jobId, data });
  },
  downForMs(): number {
    return this.downMs;
  },
};
let prisma: PrismaClient;
let other: PrismaClient;
let sample: SampleEvents;
let deps: DispatchDeps;

beforeAll(async () => {
  prisma = await db.prisma();
  other = await openClient(db);
  sample = createSampleEvents(prisma, {
    registrations: [workers.registration, ports.registration],
  });
  deps = {
    tx: sample.tx,
    subscribers: sample.events.subscribers,
    channel,
    alerts: alertsOf(sample.assembly),
  };
}, SLOW);

afterAll(async () => {
  await other?.$disconnect();
});

beforeEach(async () => {
  workers.control.failing.clear();
  ports.alerts.length = 0;
  Object.assign(channel, { down: false, downMs: 0, jobs: [] });
  // 上一条用例留下的未完成投递行一律收掉：每条用例只看自己发的事件
  await prisma.$executeRawUnsafe(
    "UPDATE outbox_delivery SET status = 'done', consumed_at = now(), lease_until = NULL WHERE status <> 'done'",
  );
}, SLOW);

/** 发一个样例事件并展开：两个订阅者各一行 pending */
async function emitPlaced(): Promise<string> {
  const dramaOrderId = uuidv7();
  const result = await sample.tx.run((tx) =>
    sample.events.emit(tx, sampleSystemContext(), {
      type: EVENT,
      aggregate: { type: "drama_order", id: dramaOrderId },
      payload: { v: 1, dramaOrderId },
    }),
  );
  while ((await sample.events.expand()).events > 0);
  return result.id as string;
}

interface Row {
  status: string;
  attempts: number;
  dispatchNo: number;
  isEnqueued: boolean;
  leased: boolean;
  /** 最近一次更新把下次可派发时间后移了多少秒 */
  backoffSec: number;
  lastError: string | null;
}
async function row(eventId: string, subscriber: string): Promise<Row> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT status, attempts::int AS attempts, dispatch_no::int AS "dispatchNo", is_enqueued AS "isEnqueued",
            lease_until IS NOT NULL AS leased, last_error AS "lastError",
            EXTRACT(EPOCH FROM next_attempt_at - updated_at)::int AS "backoffSec"
       FROM outbox_delivery WHERE outbox_event_id = $1::uuid AND subscriber = $2::text`,
    eventId,
    subscriber,
  );
  return rows[0] as Row;
}
/** 让这个事件的投递行立刻到点（退避中的）或立刻过期（租约中的） */
const hasten = (eventId: string): Promise<number> =>
  prisma.$executeRawUnsafe(
    `UPDATE outbox_delivery SET next_attempt_at = now() - interval '1 second',
            lease_until = CASE WHEN status = 'leased' THEN now() - interval '1 second' END
      WHERE outbox_event_id = $1::uuid`,
    eventId,
  );
const claim = () => deps.tx.run((tx) => claimDeliveries(tx));
const pick = (rows: readonly ClaimedDelivery[], eventId: string, subscriber: string): DeliveryRef =>
  rows.find((one) => one.eventId === eventId && one.subscriber === subscriber) as DeliveryRef;
const counts = () => workerSampleCounts(prisma);

describe("可选事务外消费准备", () => {
  it(
    "行锁等待跨过租约期限后按锁后DB时间拒绝，零事务外准备",
    async () => {
      const eventId = await emitPlaced();
      const ref = pick((await claim()).claimed, eventId, plain);
      const before = (await counts())[plain];
      await prisma.$executeRawUnsafe(
        "UPDATE outbox_delivery SET lease_until=clock_timestamp()+interval '2 seconds' WHERE outbox_event_id=$1::uuid AND subscriber=$2::text",
        eventId,
        plain,
      );
      let entered!: (pid: number) => void;
      const waiting = new Promise<number>((resolve) => {
        entered = resolve;
      });
      let called = 0;
      const prepared: DispatchDeps = {
        ...deps,
        tx: {
          run: (fn, options) =>
            deps.tx.run(async (tx) => {
              const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>(
                "SELECT pg_backend_pid() AS pid",
              );
              entered(backend!.pid);
              return fn(tx);
            }, options),
        },
        beforeConsume: async () => {
          called++;
        },
      };
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const keeper = createTxRunner({ prisma: other, appEnv: "test" }).run(async (lock) => {
        await lock.$queryRawUnsafe(
          "SELECT subscriber FROM outbox_delivery WHERE outbox_event_id=$1::uuid AND subscriber=$2::text FOR UPDATE",
          eventId,
          plain,
        );
        held();
        const pid = await waiting;
        let blocked = false;
        for (let n = 0; n < 200 && !blocked; n++) {
          const [probe] = await lock.$queryRawUnsafe<{ blocked: boolean }[]>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::int AND NOT granted) AS blocked",
            pid,
          );
          blocked = probe!.blocked;
          if (!blocked) await lock.$queryRawUnsafe("SELECT pg_sleep(0.005)::text");
        }
        expect(blocked).toBe(true);
        const [live] = await lock.$queryRawUnsafe<{ valid: boolean }[]>(
          "SELECT lease_until>clock_timestamp() AS valid FROM outbox_delivery WHERE outbox_event_id=$1::uuid AND subscriber=$2::text",
          eventId,
          plain,
        );
        expect(live!.valid).toBe(true);
        await lock.$queryRawUnsafe(
          "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM lease_until-clock_timestamp()))::double precision+0.01)::text FROM outbox_delivery WHERE outbox_event_id=$1::uuid AND subscriber=$2::text",
          eventId,
          plain,
        );
      });
      await Promise.race([holding, keeper]);
      const consuming = consumeDelivery(prepared, ref);
      try {
        await keeper;
      } finally {
        await consuming;
      }
      expect(await consuming).toBe("stale");
      expect(called).toBe(0);
      expect((await counts())[plain]).toBe(before);
      expect(await row(eventId, plain)).toMatchObject({
        status: "leased",
        attempts: 0,
        dispatchNo: ref.dispatchNo,
      });
    },
    SLOW,
  );

  it(
    "同一有效派发可准备多次，准备在事务外，最终业务仍只提交一次",
    async () => {
      const eventId = await emitPlaced();
      const ref = pick((await claim()).claimed, eventId, plain);
      const before = (await counts())[plain];
      const both = barrier(2);
      const seen: DeliveryRef[] = [];
      const prepared: DispatchDeps = {
        ...deps,
        async beforeConsume(current, event) {
          assertNotInTransaction("lyxtest.beforeConsume");
          expect(current).toEqual(ref);
          expect(event).toMatchObject({ id: eventId, type: EVENT, payload: { v: 1 } });
          seen.push(current);
          await both();
        },
      };
      const results = await Promise.all([
        consumeDelivery(prepared, ref),
        consumeDelivery(prepared, ref),
      ]);
      expect(results.sort()).toEqual(["done", "stale"]);
      expect(seen).toHaveLength(2);
      expect((await counts())[plain]).toBe(before + 1);
      expect(await row(eventId, plain)).toMatchObject({ status: "done", attempts: 0 });
    },
    SLOW,
  );

  it(
    "旧序号、过期租约与未知订阅者不准备；未知事件仍按原流程延后",
    async () => {
      const eventId = await emitPlaced();
      const old = pick((await claim()).claimed, eventId, plain);
      await hasten(eventId);
      const current = pick((await claim()).claimed, eventId, plain);
      let called = 0;
      const prepared = {
        ...deps,
        beforeConsume: async () => {
          called++;
        },
      };
      expect(await consumeDelivery(prepared, old)).toBe("stale");
      await hasten(eventId);
      expect(await consumeDelivery(prepared, current)).toBe("stale");
      await prisma.$executeRawUnsafe(
        "INSERT INTO outbox_delivery(outbox_event_id,subscriber) VALUES($1::uuid,'lyxtest.onGone')",
        eventId,
      );
      const unknown = pick((await claim()).claimed, eventId, "lyxtest.onGone");
      expect(await consumeDelivery(prepared, unknown)).toBe("deferred");
      expect(called).toBe(0);
      expect(await row(eventId, "lyxtest.onGone")).toMatchObject({
        status: "retry",
        attempts: 0,
        backoffSec: 300,
      });
    },
    SLOW,
  );

  it(
    "准备期间被重派或租约过期，最终事务fence拒绝旧业务提交",
    async () => {
      const eventId = await emitPlaced();
      const old = pick((await claim()).claimed, eventId, plain);
      const before = (await counts())[plain];
      let current = old;
      expect(
        await consumeDelivery(
          {
            ...deps,
            beforeConsume: async () => {
              // 独立连接能改行，证明预检短事务已结束、未持有投递行锁。
              await other.$executeRawUnsafe(
                "UPDATE outbox_delivery SET lease_until=now()-interval '1 second' WHERE outbox_event_id=$1::uuid",
                eventId,
              );
              current = pick((await claim()).claimed, eventId, plain);
            },
          },
          old,
        ),
      ).toBe("stale");
      expect(current.dispatchNo).toBe(old.dispatchNo + 1);
      expect((await counts())[plain]).toBe(before);
      expect(await row(eventId, plain)).toMatchObject({
        status: "leased",
        dispatchNo: current.dispatchNo,
      });
      expect(
        await consumeDelivery(
          {
            ...deps,
            beforeConsume: async () => {
              await other.$executeRawUnsafe(
                "UPDATE outbox_delivery SET lease_until=now()-interval '1 second' WHERE outbox_event_id=$1::uuid",
                eventId,
              );
            },
          },
          current,
        ),
      ).toBe("stale");
      expect((await counts())[plain]).toBe(before);
    },
    SLOW,
  );

  it(
    "准备抛错沿原失败退避，不运行订阅者；恢复后仍按新派发提交",
    async () => {
      const eventId = await emitPlaced();
      const ref = pick((await claim()).claimed, eventId, plain);
      const before = (await counts())[plain];
      const failures: string[] = [];
      const outcome = await consumeDelivery(
        {
          ...deps,
          beforeConsume: async () => {
            throw new Error("公开测试准备失败");
          },
          onFailure: (value) => {
            failures.push(value);
          },
        },
        ref,
      );
      expect(outcome).toBe("retry");
      expect(await row(eventId, plain)).toMatchObject({
        status: "retry",
        attempts: 1,
        backoffSec: 5,
        lastError: "Error: 公开测试准备失败",
      });
      expect(failures).toEqual(["retry"]);
      expect((await counts())[plain]).toBe(before);
      await hasten(eventId);
      const next = pick((await claim()).claimed, eventId, plain);
      expect(
        await consumeDelivery(
          {
            ...deps,
            beforeConsume: async () => {
              assertNotInTransaction("lyxtest.beforeConsume");
            },
          },
          next,
        ),
      ).toBe("done");
      expect((await counts())[plain]).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "Redis不可达的进程内消费也经过同一事务外准备",
    async () => {
      const eventId = await emitPlaced();
      const before = await counts();
      Object.assign(channel, { down: true, downMs: 60_000 });
      const seen: string[] = [];
      const result = await dispatchDue({
        ...deps,
        beforeConsume: async (ref, event) => {
          assertNotInTransaction("lyxtest.beforeConsume");
          expect(event.id).toBe(eventId);
          seen.push(ref.subscriber);
        },
      });
      expect(result).toMatchObject({ claimed: 2, inProcess: 2, released: 0 });
      expect(seen.sort()).toEqual([critical, plain].sort());
      const after = await counts();
      expect(after[plain]).toBe(before[plain] + 1);
      expect(after[critical]).toBe(before[critical] + 1);
    },
    SLOW,
  );
});

describe("退避与死信（验收 7）", () => {
  it(
    "失败后按 5 秒、15 秒、1 分、5 分、15 分、30 分、之后每小时后移；第 10 次进死信并告警一次",
    async () => {
      // 样例计数在文件内累计；本次失败消费的每一轮都必须零新增。
      const before = (await counts())[plain];
      workers.control.failing.add(plain);
      const eventId = await emitPlaced();
      const backoffs: number[] = [];
      for (let n = 1; n <= DELIVERY_MAX_ATTEMPTS; n += 1) {
        await hasten(eventId);
        const ref = pick((await claim()).claimed, eventId, plain);
        expect(ref.dispatchNo).toBe(n);
        const outcome = await consumeDelivery(deps, ref);
        const after = await row(eventId, plain);
        expect(after).toMatchObject({ attempts: n, leased: false });
        expect(after.lastError).toContain("按用例的安排失败");
        expect((await counts())[plain]).toBe(before);
        if (n < DELIVERY_MAX_ATTEMPTS) {
          expect([outcome, after.status]).toEqual(["retry", "retry"]);
          backoffs.push(after.backoffSec);
        } else {
          expect([outcome, after.status]).toEqual(["dead", "dead"]);
        }
      }
      expect(backoffs).toEqual([5, 15, 60, 300, 900, 1800, 3600, 3600, 3600]);
      expect(ports.alerts).toEqual([
        {
          rule: "outbox.exhausted",
          dimension: `${EVENT}:${plain}`,
          severity: "P1",
          detail: expect.objectContaining({ eventId, subscriber: plain }),
        },
      ]);
      // 死信不再自动重试；失败的订阅者没有留下业务写
      await hasten(eventId);
      expect((await claim()).claimed.filter((one) => one.subscriber === plain)).toEqual([]);
      expect((await counts())[plain] - before).toBe(0);
    },
    SLOW,
  );

  it(
    "订阅者不认识事件类型：延后 5 分钟、不计次数；持续 24 小时后按失败处理",
    async () => {
      const eventId = await emitPlaced();
      await prisma.$executeRawUnsafe(
        "INSERT INTO outbox_delivery (outbox_event_id, subscriber) VALUES ($1::uuid, 'lyxtest.onGone')",
        eventId,
      );
      const first = pick((await claim()).claimed, eventId, "lyxtest.onGone");
      expect(await consumeDelivery(deps, first)).toBe("deferred");
      expect(await row(eventId, "lyxtest.onGone")).toMatchObject({
        status: "retry",
        attempts: 0,
        backoffSec: 300,
        leased: false,
      });

      await prisma.$executeRawUnsafe(
        `UPDATE outbox_delivery SET created_at = now() - interval '25 hours'
          WHERE outbox_event_id = $1::uuid AND subscriber = 'lyxtest.onGone'`,
        eventId,
      );
      await hasten(eventId);
      const later = pick((await claim()).claimed, eventId, "lyxtest.onGone");
      expect(await consumeDelivery(deps, later)).toBe("retry");
      expect(await row(eventId, "lyxtest.onGone")).toMatchObject({
        status: "retry",
        attempts: 1,
        backoffSec: DELIVERY_BACKOFF_SEC[0],
      });
    },
    SLOW,
  );
});

describe("派发序号与重复送达", () => {
  it(
    "被新一次派发接管的那次不落结果；同一次派发送达多次，业务副作用只有一次",
    async () => {
      const eventId = await emitPlaced();
      const before = (await counts())[plain];
      const old = pick((await claim()).claimed, eventId, plain);
      await hasten(eventId);
      const current = pick((await claim()).claimed, eventId, plain);
      expect([old.dispatchNo, current.dispatchNo]).toEqual([1, 2]);

      expect(await consumeDelivery(deps, old)).toBe("stale");
      expect(await row(eventId, plain)).toMatchObject({ status: "leased", dispatchNo: 2 });
      expect((await counts())[plain]).toBe(before);

      // 队列把同一条任务送达 6 次，同时到
      const delivered = await deliverRepeatedly((ref) => consumeDelivery(deps, ref), current, {
        times: 6,
        mode: "concurrent",
      });
      expect(delivered.rejected).toEqual([]);
      expect(delivered.fulfilled.filter((one) => one === "done")).toHaveLength(1);
      expect(delivered.fulfilled.filter((one) => one === "stale")).toHaveLength(5);
      expect(await row(eventId, plain)).toMatchObject({ status: "done", attempts: 0 });
      expect((await counts())[plain]).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "租约过期重派：上一次已入队的记一次失败（处理器失联），没入队的不记；失联满 10 次进死信并告警",
    async () => {
      const enqueuedId = await emitPlaced();
      expect(await dispatchDue(deps)).toMatchObject({ claimed: 2, enqueued: 2 });
      expect(channel.jobs.map((job) => [job.queue, job.jobId])).toContainEqual([
        OUTBOX_QUEUE,
        deliveryJobId({ eventId: enqueuedId, subscriber: plain, dispatchNo: 1 }),
      ]);
      expect(await row(enqueuedId, plain)).toMatchObject({ status: "leased", isEnqueued: true });
      const notEnqueuedId = await emitPlaced();
      await claim();

      await Promise.all([hasten(enqueuedId), hasten(notEnqueuedId)]);
      await claim();
      expect(await row(enqueuedId, plain)).toMatchObject({
        status: "leased",
        dispatchNo: 2,
        attempts: 1,
        isEnqueued: false,
      });
      expect(await row(notEnqueuedId, plain)).toMatchObject({ dispatchNo: 2, attempts: 0 });

      await prisma.$executeRawUnsafe(
        `UPDATE outbox_delivery SET attempts = 9, is_enqueued = true, lease_until = now() - interval '1 second'
          WHERE outbox_event_id = $1::uuid AND subscriber = $2::text`,
        enqueuedId,
        plain,
      );
      expect(await dispatchDue(deps)).toMatchObject({ dead: 1 });
      expect(await row(enqueuedId, plain)).toMatchObject({ status: "dead", attempts: 10 });
      expect(ports.alerts.map((alert) => [alert.rule, alert.dimension])).toEqual([
        ["outbox.exhausted", `${EVENT}:${plain}`],
      ]);
    },
    SLOW,
  );
});

describe("入队失败（Redis 不可用）", () => {
  it(
    "关键类在进程内执行；非关键类放回 pending、不计次数；连续不可用满 60 秒后非关键类也在进程内执行",
    async () => {
      const eventId = await emitPlaced();
      const before = await counts();
      Object.assign(channel, { down: true, downMs: 59_999 });
      expect(await dispatchDue(deps)).toEqual({
        claimed: 2,
        enqueued: 0,
        inProcess: 1,
        released: 1,
        dead: 0,
      });
      expect(await row(eventId, critical)).toMatchObject({ status: "done", attempts: 0 });
      expect(await row(eventId, plain)).toMatchObject({
        status: "pending",
        attempts: 0,
        leased: false,
        isEnqueued: false,
      });
      expect(await counts()).toMatchObject({
        [critical]: before[critical] + 1,
        [plain]: before[plain],
      });

      channel.downMs = 60_000;
      expect(await dispatchDue(deps)).toMatchObject({ claimed: 1, inProcess: 1, released: 0 });
      expect(await row(eventId, plain)).toMatchObject({ status: "done", attempts: 0 });
      expect((await counts())[plain]).toBe(before[plain] + 1);
    },
    SLOW,
  );
});

describe("两个实例同时认领（并发）", () => {
  it(
    "各拿各的：合起来不重不漏，谁也不等谁",
    async () => {
      const right = createTxRunner({ prisma: other, appEnv: "test" });
      for (let round = 0; round < 5; round += 1) {
        const eventIds = await Promise.all(Array.from({ length: 12 }, emitPlaced));
        const grab = (runner: typeof right, together: () => Promise<void>) =>
          runner.run(async (tx) => {
            await together();
            return (await claimDeliveries(tx, 15)).claimed;
          });
        const taken: ClaimedDelivery[] = [];
        // 每边一次至多 15 行：两边对齐到同一时刻再拿，来回拿到空
        for (;;) {
          const together = barrier(2);
          const [a, b] = await Promise.all([grab(sample.tx, together), grab(right, together)]);
          if (a.length + b.length === 0) break;
          taken.push(...a, ...b);
        }
        const keys = taken.map((one) => `${one.eventId}:${one.subscriber}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(new Set(keys)).toEqual(
          new Set(eventIds.flatMap((id) => [`${id}:${critical}`, `${id}:${plain}`])),
        );
        expect(taken.every((one) => one.dispatchNo === 1)).toBe(true);
        await prisma.$executeRawUnsafe(
          "UPDATE outbox_delivery SET status = 'done', consumed_at = now(), lease_until = NULL WHERE status <> 'done'",
        );
      }
    },
    SLOW,
  );
});

describe("失败序列的性质", () => {
  it(
    "任意的成败序列：失败次数等于抛错的次数，第一次成功即 done 且副作用恰一次，满 10 次失败即 dead",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (plan) => {
          const eventId = await emitPlaced();
          const before = (await counts())[plain];
          let failures = 0;
          let status = "pending";
          for (const succeed of plan) {
            if (status === "done" || status === "dead") break;
            if (succeed) workers.control.failing.delete(plain);
            else workers.control.failing.add(plain);
            await hasten(eventId);
            const outcome = await consumeDelivery(
              deps,
              pick((await claim()).claimed, eventId, plain),
            );
            if (!succeed) failures += 1;
            status = (await row(eventId, plain)).status;
            expect(outcome).toBe(status);
          }
          const after = await row(eventId, plain);
          expect(after.attempts).toBe(failures);
          const expected = plan.slice(0, DELIVERY_MAX_ATTEMPTS).includes(true)
            ? "done"
            : failures >= DELIVERY_MAX_ATTEMPTS
              ? "dead"
              : "retry";
          expect(after.status).toBe(expected);
          expect((await counts())[plain]).toBe(before + (expected === "done" ? 1 : 0));
        }),
        {
          numRuns: Number(process.env.LYX_FC_RUNS ?? 15),
          seed: Number(process.env.LYX_FC_SEED ?? 20261005),
        },
      );
    },
    SLOW,
  );
});
