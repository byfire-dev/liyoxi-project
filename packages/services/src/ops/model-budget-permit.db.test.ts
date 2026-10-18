import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { assertNotInTransaction, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createMediaAssetsHarness,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createModelBudgetLedger } from "../media/index.js";
import type { ModelBudgetFacts, ModelBudgetAdmission } from "../media/index.js";
import { readModelBudgetPermit } from "./index.js";

// 真实追加修订的合法/损坏历史fixture；不UPDATE/delete/cancel任何参数记录。
const db = useSeededDatabase("services"),
  redis = useTestRedis(),
  SLOW = 120000;
const clock = createClock(new Date("2026-10-12T04:00:00Z"));
let prisma: Awaited<ReturnType<typeof db.prisma>>, tx: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, SLOW);
beforeEach(async () => {
  await db.reset();
  clock.set(new Date("2026-10-12T04:00:00Z"));
}, SLOW);
const keys = ["media.assets.daily_file_cap", "media.model.daily_call_cap"] as const;
function facts(): ModelBudgetFacts {
  const at = clock.now().getTime();
  return {
    entityId: uuidv7(),
    storeId: uuidv7(),
    jobId: uuidv7(),
    fileIds: [uuidv7()],
    kind: "vision",
    attemptNo: 1,
    expectedSourceHash: "a".repeat(64),
    readAtMs: at,
    admitUntilMs: at + 250,
    leaseUntilMs: at + 120000,
    originalDeadlineMs: at + 900000,
  };
}
async function revision(
  key: (typeof keys)[number],
  value: Prisma.InputJsonValue,
  effectiveAt = clock.now(),
) {
  return prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key,
      value,
      effectiveAt,
      createdByStaffId: uuidv7(),
      createdAt: clock.now(),
      reason: "公开虚构预算参数历史",
    },
  });
}
async function rows() {
  return prisma.paramValue.findMany({ where: { key: { in: [...keys] } }, orderBy: { seq: "asc" } });
}

describe("生产组合根同Tx预算参数公口", { timeout: SLOW }, () => {
  it("正式缺省200/0关闭且零参数/alert/outbox旁写", async () => {
    const before = await rows();
    expect(await tx.run((handle) => readModelBudgetPermit(handle, facts()))).toBeNull();
    expect(await rows()).toEqual(before);
    expect(await prisma.alertEvent.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it.each([
    [0, 10000],
    [200, 0],
    [0, 0],
  ])("合法0关闭 files=%d/calls=%d", async (files, calls) => {
    await revision(keys[0], files);
    await revision(keys[1], calls);
    const before = await rows();
    expect(await tx.run((handle) => readModelBudgetPermit(handle, facts()))).toBeNull();
    expect(await rows()).toEqual(before);
  });

  it.each([
    [1, 1],
    [200, 10000],
  ])("正式边界%d/%d保持完整不可变11事实", async (files, calls) => {
    await revision(keys[0], files);
    await revision(keys[1], calls);
    const input = facts(),
      before = structuredClone(input);
    const permit = await tx.run((handle) => readModelBudgetPermit(handle, input));
    expect(permit).toEqual({ ...before, dailyFileCap: files, dailyCallCap: calls });
    expect(Object.keys(permit!)).toHaveLength(13);
    expect(Object.isFrozen(permit)).toBe(true);
    expect(Object.isFrozen(permit!.fileIds)).toBe(true);
    expect(input).toEqual(before);
  });

  it.each([
    ["media.assets.daily_file_cap", 201],
    ["media.assets.daily_file_cap", "10"],
    ["media.model.daily_call_cap", -1],
    ["media.model.daily_call_cap", 1.5],
    ["media.model.daily_call_cap", 10001],
  ] as const)("损坏历史%s=%s不能宽松回退或活Tx告警", async (key, value) => {
    await revision(keys[0], 200, new Date(clock.now().getTime() - 1));
    await revision(keys[1], 10000, new Date(clock.now().getTime() - 1));
    await revision(key, value);
    const before = await rows();
    await expect(tx.run((handle) => readModelBudgetPermit(handle, facts()))).rejects.toThrow(
      "模型预算参数非法",
    );
    expect(await rows()).toEqual(before);
    expect(await prisma.alertEvent.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("未来正式修订只在fresh readAt生效，旧paid窗口不会由reader扩展", async () => {
    await revision(keys[0], 200);
    await revision(keys[1], 10000);
    const at = facts(),
      first = await tx.run((handle) => readModelBudgetPermit(handle, at));
    clock.advance(1);
    await revision(keys[1], 3);
    const latest = await tx.run((handle) =>
      readModelBudgetPermit(handle, { ...at, readAtMs: clock.now().getTime() }),
    );
    expect(first?.dailyCallCap).toBe(10000);
    expect(latest?.dailyCallCap).toBe(3);
    expect(latest?.admitUntilMs).toBe(at.admitUntilMs);
    expect(latest?.originalDeadlineMs).toBe(at.originalDeadlineMs);
    expect(await tx.run((handle) => readModelBudgetPermit(handle, at))).toEqual(first);
    expect(await prisma.paramValue.count({ where: { key: { in: [...keys] } } })).toBe(3);
  });

  it("同一真实Tx未提交修订可见，外层失败全部回滚且无外部告警", async () => {
    const before = await rows(),
      input = facts();
    await expect(
      tx.run(async (handle) => {
        for (const [index, key] of keys.entries())
          await handle.paramValue.create({
            data: {
              id: uuidv7(),
              key,
              value: index === 0 ? 200 : 3,
              effectiveAt: clock.now(),
              createdByStaffId: uuidv7(),
              createdAt: clock.now(),
            },
          });
        expect(await readModelBudgetPermit(handle, input)).toEqual({
          ...input,
          dailyFileCap: 200,
          dailyCallCap: 3,
        });
        expect(await prisma.paramValue.count({ where: { key: { in: [...keys] } } })).toBe(0);
        throw new Error("外层rollback");
      }),
    ).rejects.toThrow("外层rollback");
    expect(await rows()).toEqual(before);
    expect(await prisma.alertEvent.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("真实摘要任务P1正式参数→PG外真账本→P2新修订拒绝，已付三槽不退款", async () => {
    const client = await redis.raw();
    const readPermit = vi.fn(readModelBudgetPermit);
    const reserve: ModelBudgetAdmission["reserve"] = async (context, abort) => {
      assertNotInTransaction("预算组合根Redis预留");
      const decision = await ledger.reserve(context, abort);
      if (decision.status === "reserved") {
        h.clock.advance(1);
        await revision(keys[1], 3, h.clock.now());
      }
      return decision;
    };
    const h = await createMediaAssetsHarness(prisma, { modelBudget: { readPermit, reserve } });
    const prefix = `${redis.prefix}ops:${uuidv7()}:`,
      key = `${prefix}model_budget:v1`;
    const ledger = createModelBudgetLedger({
      clock: h.clock,
      prefix,
      transport: {
        eval: async (script, targets, argv) =>
          client.eval(script, targets.length, ...targets, ...argv),
      },
    });
    try {
      const [seconds, micros] = await client.time();
      const at = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
      h.clock.set(new Date(at));
      await client.hset(key, {
        marker: "model_budget_v1",
        business: String(at - 1),
        redis: String(at - 1),
        day: String(Math.floor((at + 28800000) / 86400000)),
        closed: "0",
        head: "1",
        next: "1",
        cursor: "1",
      });
      await revision(keys[0], 200, new Date(at));
      await revision(keys[1], 10000, new Date(at));
      const asset = await h.media.assets.create(h.owner, {
        type: "text",
        textBody: "公开虚构菜单",
      });
      const audit = await prisma.mediaJob.findFirstOrThrow({
        where: { parentId: asset.storeAssetId, kind: "audit_text" },
      });
      await h.media.jobs.run({ jobId: audit.id });
      const job = await prisma.mediaJob.findFirstOrThrow({
        where: { parentId: asset.storeAssetId, kind: "digest" },
      });
      const current = await client.time();
      h.clock.set(new Date(Number(current[0]) * 1000 + Math.floor(Number(current[1]) / 1000)));
      await h.media.jobs.run({ jobId: job.id });
      expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
        "canceled",
      );
      expect(readPermit).toHaveBeenCalledTimes(2);
      expect(readPermit.mock.calls[1]![1].admitUntilMs).toBe(
        readPermit.mock.calls[0]![1].admitUntilMs,
      );
      expect(h.fake.llm.callsOf("summarizeAsset")).toHaveLength(0);
      const all = await client.hgetall(key);
      expect(
        Object.entries(all)
          .filter(([name]) => name.startsWith("g:"))
          .map(([, value]) => value),
      ).toEqual(["3"]);
      expect(all[`t:${job.id}:1:digest`]).toBe(String(job.deadlineAt.getTime()));
      expect(await prisma.paramValue.count({ where: { key: { in: [...keys] } } })).toBe(3);
      expect(await prisma.alertEvent.count()).toBe(0);
    } finally {
      await h.close();
    }
  });
});
