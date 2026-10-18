import { afterEach, describe, expect, it } from "vitest";
import { createSmsHealth } from "../notify/index.js";
import { notificationFixture, TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import { createNotifyAssembly } from "./notify-runtime.js";

const db = useSeededDatabase("services");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
async function scope() {
  const h = notificationFixture(await db.prisma());
  const raised: unknown[] = [];
  const health = createSmsHealth({
    db: h.prisma,
    tx: h.tx,
    clock: h.clock,
    config: h.config,
    sms: h.providers.sms,
    alerts: {
      async raise(input) {
        raised.push(input);
      },
    },
    env: "test",
    keyring: () => TEST_KEYRING,
  });
  const assembly = createNotifyAssembly(h.deps.assembly);
  assembly.attach(h.service);
  assembly.attachSmsHealth(health);
  closers.push(() => assembly.close());
  const context = { scheduledFor: h.clock.now(), runTx: h.tx.run.bind(h.tx) };
  return { h, health, assembly, raised, context };
}

describe("真实L4 assembly copy承接两健康job，不使用全局最后绑定", () => {
  it("两scope的jobs/lookup指向各自闭包；关A后B照常受控报告，原元数据完整保留", async () => {
    await db.reset();
    const a = await scope();
    const b = await scope();
    for (const kind of ["notify.sms_balance", "notify.sms_keepalive"] as const) {
      const base = a.h.deps.assembly.recurringJob(kind)!;
      const actual = a.assembly.assembly.recurringJob(kind)!;
      const { run: _baseRun, ...baseMetadata } = base;
      const { run: _actualRun, ...actualMetadata } = actual;
      expect(actualMetadata).toEqual(baseMetadata);
      expect(actual).toBe(a.assembly.assembly.recurringJobs.find((item) => item.kind === kind));
      await expect(base.run(a.context)).rejects.toThrow("需要本运行时装配");
    }
    expect(
      await a.assembly.assembly.recurringJob("notify.sms_balance")!.run(a.context),
    ).toMatchObject({ outcome: "unsupported", queried: false });
    expect(a.raised).toHaveLength(1);
    expect(b.raised).toHaveLength(0);
    await a.assembly.close();
    expect(() => a.assembly.assembly.recurringJob("notify.sms_balance")!.run(a.context)).toThrow(
      "已经关闭",
    );
    expect(
      await b.assembly.assembly.recurringJob("notify.sms_balance")!.run(b.context),
    ).toMatchObject({ outcome: "unsupported", queried: false });
    expect(b.raised).toHaveLength(1);
    expect(
      await b.assembly.assembly.recurringJob("notify.sms_keepalive")!.run(b.context),
    ).toMatchObject({ outcome: "no_internal_target" });
    expect(a.h.providers.sms.callsOf("checkBalance")).toHaveLength(0);
    expect(b.h.providers.sms.callsOf("checkBalance")).toHaveLength(0);
  }, 60_000);

  it("未attach和重复attach拒绝；关闭后不能把新服务重新挂到旧copy", async () => {
    await db.reset();
    const h = notificationFixture(await db.prisma());
    const assembly = createNotifyAssembly(h.deps.assembly);
    closers.push(() => h.service.close());
    closers.push(() => assembly.close());
    const context = { scheduledFor: h.clock.now(), runTx: h.tx.run.bind(h.tx) };
    expect(() => assembly.assembly.recurringJob("notify.sms_balance")!.run(context)).toThrow(
      "尚未绑定",
    );
    const health = createSmsHealth({
      db: h.prisma,
      tx: h.tx,
      clock: h.clock,
      config: h.config,
      sms: h.providers.sms,
      alerts: { async raise() {} },
      env: "test",
      keyring: () => TEST_KEYRING,
    });
    assembly.attachSmsHealth(health);
    expect(() => assembly.attachSmsHealth(health)).toThrow("只能绑定一次");
    await assembly.close();
    expect(() => assembly.attachSmsHealth(health)).toThrow("只能绑定一次");
    expect(await health.keepalive(context)).toEqual({ outcome: "cancelled" });
  }, 60_000);
});
