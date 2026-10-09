// Each assembly owns its closures; tests use actual TxRunner and append-only evidence storage.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDocsAdminFixture, useSeededDatabase } from "../testing/index.js";
import { createDocsAssembly } from "./docs-runtime.js";

const db = useSeededDatabase("services");
let one: ReturnType<typeof createDocsAdminFixture>;
let two: ReturnType<typeof createDocsAdminFixture>;
beforeAll(async () => {
  const prisma = await db.prisma();
  one = createDocsAdminFixture(prisma);
  two = createDocsAdminFixture(prisma);
});
afterAll(async () => {
  await two?.close();
  await one?.close();
});

describe("文书scoped assembly", () => {
  it("真实两个scope的job/索引同对象，各写自己的Storage且关一不重定向另一", async () => {
    const a = one.assembly.recurringJob("evidence.consent_digest")!;
    const b = two.assembly.recurringJob("evidence.consent_digest")!;
    expect(a).toBe(one.assembly.recurringJobs.find((item) => item.kind === a.kind));
    expect(a).not.toBe(b);
    await a.run({ scheduledFor: new Date("2026-10-01T16:40:00.000Z") });
    expect(one.providers.storage.objects.size).toBe(1);
    expect(two.providers.storage.objects.size).toBe(0);
    await one.scope.close();
    expect(() => a.run({ scheduledFor: one.clock.now() })).toThrow("已经关闭");
    await b.run({ scheduledFor: new Date("2026-10-02T16:40:00.000Z") });
    expect(two.providers.storage.objects.size).toBe(1);
    expect(one.providers.storage.objects.size).toBe(1);
  });
  it("关闭取消在途真实Storage HEAD并等待清理，保留另一scope和原N5对象", async () => {
    const scope = createDocsAssembly(two.assembly);
    scope.attach(two.jobs);
    expect(scope.assembly.invariant("docs.N5")).toBe(two.assembly.invariant("docs.N5"));
    expect(scope.assembly.recurringJob("notify.remind_scan")).toBe(
      two.assembly.recurringJob("notify.remind_scan"),
    );
    const original = two.providers.storage.head;
    let entered!: () => void,
      cleaned = false;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(two.providers.storage, "head").mockImplementation(async (input) => {
      entered();
      try {
        await new Promise<void>((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      } finally {
        cleaned = true;
      }
      return original(input);
    });
    const job = scope.assembly
      .recurringJob("evidence.consent_digest")!
      .run({ scheduledFor: new Date("2026-10-03T16:40:00.000Z") });
    const settled = Promise.allSettled([job]);
    await reached;
    await scope.close();
    expect(cleaned).toBe(true);
    expect((await settled)[0]?.status).toBe("rejected");
    spy.mockRestore();
    await expect(
      two.assembly
        .recurringJob("evidence.consent_digest")!
        .run({ scheduledFor: new Date("2026-10-04T16:40:00.000Z") }),
    ).resolves.toMatchObject({ created: true });
  });
  it("N4使用本次invariant业务时刻而非runtime钟；未绑定/已关scope拒绝", async () => {
    const early = two.clock.now(),
      effective = new Date(early.getTime() + 86400000);
    await two.make.agreementVersion({
      agreementKey: "privacy",
      status: "active",
      effectiveAt: effective,
    });
    await two.make.agreementVersion({
      agreementKey: "privacy",
      status: "pending",
      effectiveAt: effective,
    });
    const run = two.assembly.invariant("docs.N4")!.run!;
    const before = await two.tx.run((tx) => run(tx, {}, { now: early }));
    expect(before.filter((v) => v.detail.problem === "current_version_not_unique")).toHaveLength(0);
    const after = await two.tx.run((tx) => run(tx, {}, { now: new Date(effective.getTime() + 1) }));
    expect(after.filter((v) => v.detail.problem === "current_version_not_unique")).toHaveLength(2);
    const unbound = createDocsAssembly(two.assembly);
    expect(() => unbound.assembly.recurringJob("docs.sweep")!.run({ scheduledFor: early })).toThrow(
      "尚未绑定",
    );
    await unbound.close();
    expect(() => unbound.attach(two.jobs)).toThrow("只能绑定一次");
  });
  it("close等待已有TX结束并回滚到期簿记，不在返回后留后台DML", async () => {
    const actor = await two.actor();
    const d = await two.draft(
      actor,
      "custom_license",
      new Date(two.clock.now().getTime() + 600001),
    );
    await two.admin.scheduleVersion(actor, d.version.id, { lockVersion: 0 });
    two.clock.advance(600001);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = createDocsAssembly(two.assembly);
    scope.attach({
      ...two.jobs,
      countActiveUsers: async (tx) => {
        entered();
        await gate;
        return two.jobs.countActiveUsers(tx);
      },
    });
    const running = scope.assembly
      .recurringJob("docs.sweep")!
      .run({ scheduledFor: two.clock.now() });
    const settled = Promise.allSettled([running]);
    await reached;
    let closed = false;
    const closing = scope.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await settled)[0]?.status).toBe("rejected");
    const row = await two.prisma.agreementVersion.findUniqueOrThrow({
      where: { id: d.version.id },
    });
    expect(row).toMatchObject({ status: "pending", activatedAt: null });
    expect(
      await two.prisma.auditLog.count({
        where: { targetId: d.version.id, action: "docs.agreement_version.activate" },
      }),
    ).toBe(0);
  });
}, 60_000);
