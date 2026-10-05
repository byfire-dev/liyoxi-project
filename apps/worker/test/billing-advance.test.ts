import { LOOPS } from "@liyoxi/contract/registry";
import {
  createClock,
  createLedgerHarness,
  dumpLedger,
  joinLedger,
  openTerm,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import type { LedgerHarness } from "@liyoxi/services/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { createHarness, SLOW } from "./support/harness.js";
import type { Harness } from "./support/harness.js";
import type { Instance } from "./support/instance.js";

// 任务书 W1-10 第 7 节验收 10（循环的一半）：账务推进循环 billing_advance 每分钟一轮，
// 取 next_due_at 已到的主体、SKIP LOCKED、逐个 advance；一个主体出错不影响别的主体，并报一条告警。

const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("worker");
const redis = useTestRedis();
const clock = createClock();
let h: Harness;
let ledger: LedgerHarness;
let other: Awaited<ReturnType<typeof joinLedger>>;

beforeAll(async () => {
  h = await createHarness(db, redis);
  ledger = createLedgerHarness(h.prisma, { clock });
  other = await joinLedger(ledger, h.databaseUrl);
}, SLOW);

afterAll(async () => {
  await other?.close();
});

/** 起一个任务进程实例（用例结束时自动收尾），与账本夹具共用一只时钟 */
const startWorker = (): Promise<Instance> => h.instance({ clock });
const subscribed = async (): Promise<string> => {
  const { entity } = await ledger.make.merchant({ verified: true });
  await openTerm(ledger, { entityId: entity.id });
  return entity.id;
};
const statusOf = async (entityId: string) =>
  (await dumpLedger(h.prisma, entityId)).account.subStatus;

describe("账务推进循环 billing_advance（验收 10）", () => {
  it("每分钟一轮；名字在契约的循环登记里；任务进程的运行时里有它", async () => {
    const worker = await startWorker();
    const def = DOMAIN_LOOPS.find((loop) => loop.name === "billing_advance");
    expect(def?.intervalMs).toBe(60_000);
    expect(LOOPS.map((loop) => loop.id)).toContain("billing_advance");
    expect(worker.runtime.domainLoops["billing_advance"]).toMatchObject({
      name: "billing_advance",
      intervalMs: 60_000,
    });
  });

  it(
    "一轮：到点的主体逐个推进（清零、过期停用），没到点的不动",
    async () => {
      const worker = await startWorker();
      clock.set(at("2026-01-05T12:00:00"));
      const [first, second] = [await subscribed(), await subscribed()];
      clock.set(at("2026-01-20T12:00:00"));
      const later = await subscribed();

      // 前两个主体的止点是 02-05 00:00，第三个是 02-20 00:00
      clock.set(at("2026-02-05T00:00:30"));
      await worker.runtime.domainLoops["billing_advance"]?.tick();
      expect(await statusOf(first)).toBe("expired");
      expect(await statusOf(second)).toBe("expired");
      expect(await statusOf(later)).toBe("active");
      const summary = await worker.services.advanceBilling();
      expect(summary).toEqual({ due: 0, advanced: 0, skipped: 0, failed: [] });
    },
    SLOW,
  );

  it(
    "账户被别的事务占着就跳过、不等；一个主体出错不影响别的，报一条告警，它下一轮再试",
    async () => {
      const worker = await startWorker();
      clock.set(at("2026-03-01T12:00:00"));
      // 先把前面的用例留下的到点主体推进完
      await worker.services.advanceBilling();
      const [busy, broken, fine] = [await subscribed(), await subscribed(), await subscribed()];
      // broken 的缓存被改坏：推进它会被写入时自检拦下
      await h.prisma.billingAccount.update({
        where: { entityId: broken },
        data: { addonAvailableQty: { increment: 9 } },
      });
      clock.set(at("2026-04-01T00:00:30"));

      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const holder = other.tx.run(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM billing_account WHERE entity_id = ${busy}::uuid FOR UPDATE`;
          locked();
          await released;
        },
        { timeoutMs: 60_000 },
      );
      await holding;
      const first = await worker.services.advanceBilling();
      release();
      await holder;

      expect(first).toEqual({ due: 3, advanced: 1, skipped: 1, failed: [broken] });
      expect(await statusOf(fine)).toBe("expired");
      expect(await statusOf(busy)).toBe("active");
      expect(worker.ports.alerts).toMatchObject([
        { rule: "billing.advance_failed", dimension: broken, severity: "P1" },
      ]);

      // 下一轮：放开了的那个推进了；坏的那个仍然到点、仍然报错，不前进
      const second = await worker.services.advanceBilling();
      expect(second).toEqual({ due: 2, advanced: 1, skipped: 0, failed: [broken] });
      expect(await statusOf(busy)).toBe("expired");
      expect(await statusOf(broken)).toBe("active");
    },
    SLOW,
  );
});
