import { createPrismaClient } from "@liyoxi/db";
import { testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeDelivery, createEvents, dispatchDue } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import { createIdentityContext, createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import { complete, harness as profileHarness, submit } from "../profile/__fixtures__/harness.js";
import { assembleForTest, createFakeProviders, useSeededDatabase } from "../testing/index.js";
import { createProfileLifecycleAssembly } from "./profile-lifecycle-runtime.js";
import { buildWorkerServices } from "./worker.js";
import { DAY, START, lifecycleWorld } from "./__fixtures__/profile-lifecycle.js";
import type {
  ArchiveReason,
  LifecycleOwner,
  LifecycleType,
  LifecycleWorld,
  RoundKind,
} from "./__fixtures__/profile-lifecycle.js";

const db = useSeededDatabase("services", { label: "profilelife", max: 4 });
const kinds: RoundKind[] = ["initial", "new_store", "change"];
const types: LifecycleType[] = [
  "entity.closed",
  "entity.abandoned",
  "store.archived",
  "store.draft_deleted",
  "store.restored",
];
let h: LifecycleWorld;
const workers: ReturnType<typeof buildWorkerServices>[] = [];
let lifecycleWorker: ReturnType<typeof buildWorker> | undefined;
beforeAll(async () => {
  h = lifecycleWorld(await db.prisma());
}, 120_000);
beforeEach(() => h.clock.set(START));
afterAll(async () => {
  h.scope.close();
  for (const one of workers.reverse()) {
    one.closeProfile?.();
    one.closeApproval?.();
    await one.shutdownMediaJobs?.();
    one.closeMediaJobs?.();
    await one.closeDocs();
    await one.documentConverter?.close();
    await one.closeNotify();
    await one.closeAnalytics?.();
    await one.closeStaff?.();
    await one.closeSmsHealth?.();
    await one.closeAlertFacts?.();
    one.closeOrder?.();
    one.closeBillingTimers?.();
    one.closePublish?.();
    one.closeDelivery?.();
    one.closeWebhooks?.();
    await one.closeMediaDrivers?.();
    await one.closeStorageDrivers?.();
  }
});
const later = (anchor: Date, days: number) => new Date(anchor.getTime() + days * DAY);
const threeYears = (anchor: Date) => {
  const result = new Date(anchor);
  result.setUTCFullYear(result.getUTCFullYear() + 3);
  return result;
};
const live = { state: "live", releasedAt: null, keepUntil: null };
async function draft(kind: RoundKind = "initial") {
  return h.draft(await h.owner(kind), kind);
}
async function submitted(kind: RoundKind = "initial") {
  return h.submitted(await draft(kind));
}
async function assertReleased(
  input: Parameters<LifecycleWorld["readRef"]>[0],
  keepUntil: Date,
  releasedAt = h.clock.now(),
) {
  expect(await h.readRef(input)).toEqual({ state: "released", releasedAt, keepUntil });
}
function buildWorker() {
  const deliveries: DeliveryRef[] = [];
  const one = buildWorkerServices({
    appEnv: "test",
    prisma: h.prisma,
    clock: h.clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock: h.clock }),
    channel: {
      downForMs: () => 0,
      enqueue: async (_queue, _id, raw) => {
        if (typeof raw !== "object" || raw === null) return;
        if (
          "eventId" in raw &&
          typeof raw.eventId === "string" &&
          "subscriber" in raw &&
          typeof raw.subscriber === "string" &&
          "dispatchNo" in raw &&
          typeof raw.dispatchNo === "number"
        )
          deliveries.push({
            eventId: raw.eventId,
            subscriber: raw.subscriber,
            dispatchNo: raw.dispatchNo,
          });
      },
    },
  });
  workers.push(one);
  return { one, deliveries };
}
async function queued(
  o: LifecycleOwner,
  event: DeliveredEvent,
  worker: ReturnType<typeof buildWorker>,
) {
  const eventId = await h.emit(o, event, worker.one.events);
  await worker.one.relay();
  await worker.one.dispatch();
  const refs = worker.deliveries.filter(
    (r) => r.eventId === eventId && r.subscriber === "profile.onTenantLifecycle",
  );
  expect(refs).toHaveLength(1);
  return refs[0]!;
}
async function secondStore(o: LifecycleOwner) {
  const store = await h.make.store({ entityId: o.entity.id, qualificationStatus: "verified" });
  await h.prisma.storeProfile.create({
    data: {
      entityId: o.entity.id,
      storeId: store.id,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  return {
    ...o,
    store,
    ctx: createIdentityContext({ actor: o.ctx.actor, entityId: o.entity.id, storeId: store.id }),
  };
}

describe("profile 五事件严格边界与真实当前事实", () => {
  it.each(types)("%s 拒绝未知字段、坏ID、错误版本及缺字段，全领域零写", async (type) => {
    const o = await h.owner();
    const e = await h.event(o, type);
    const before = await h.snapshot(o.entity.id);
    for (const payload of [
      { ...(e.payload as object), secret: "不得进入载荷" },
      { ...(e.payload as object), entityId: "bad" },
      { ...(e.payload as object), v: 2 },
      { v: 1 },
      null,
    ]) {
      await expect(
        h.invoke({ ...e, payload: payload as unknown as DeliveredEvent["payload"] }),
      ).rejects.toBeDefined();
      expect(await h.snapshot(o.entity.id)).toEqual(before);
    }
  });
  it("未知事件明确拒绝，五事件 subscriber 只登记一次", async () => {
    const o = await h.owner();
    await expect(
      h.invoke({ id: uuidv7(), type: "store.unregistered", payload: {} }),
    ).rejects.toBeDefined();
    const entries = h.assembly.subscribers.filter((s) => s.name === "profile.onTenantLifecycle");
    expect(entries).toHaveLength(1);
    expect([...entries[0]!.events].sort()).toEqual([...types].sort());
    for (const type of types)
      expect(
        h.events.subscribers.forEvent(type).filter((s) => s.name === entries[0]!.name),
      ).toHaveLength(1);
    expect((await h.snapshot(o.entity.id)).rounds).toEqual([]);
  });
  it.each(types)("%s 的旧事实对当前 active/另一终态无副作用", async (type) => {
    const f = await draft();
    const e = await h.event(f, type);
    if (type === "store.restored") await h.archive(f);
    const before = await h.snapshot(f.entity.id);
    await h.invoke(e);
    expect(await h.snapshot(f.entity.id)).toEqual(before);
    expect(await h.readRef(f.input)).toEqual(live);
  });
  it("门店与主体交叉载荷不能改动任一主体的草稿或引用", async () => {
    const a = await draft(),
      b = await draft();
    await h.archive(a);
    await h.archive(b);
    const event = await h.event(a, "store.archived");
    const beforeA = await h.snapshot(a.entity.id),
      beforeB = await h.snapshot(b.entity.id);
    await h
      .invoke({ ...event, payload: { ...(event.payload as object), entityId: b.entity.id } })
      .catch(() => undefined);
    expect(await h.snapshot(a.entity.id)).toEqual(beforeA);
    expect(await h.snapshot(b.entity.id)).toEqual(beforeB);
  });
});

describe("草稿丢弃及三类真实系统撤回", () => {
  it.each(["initial", "new_store"] as const)(
    "%s 撤回精确回到真实pending前的rejected状态",
    async (kind) => {
      const o = await h.owner(kind);
      await h.prisma.store.update({
        where: { id: o.store.id },
        data: { qualificationStatus: "rejected" },
      });
      if (kind === "initial")
        await h.prisma.entity.update({
          where: { id: o.entity.id },
          data: { verificationStatus: "rejected" },
        });
      const f = await h.submitted(await h.draft(o, kind));
      await h.terminate(f);
      await h.invoke(await h.event(f, "entity.closed"));
      const after = await h.snapshot(f.entity.id);
      expect(after.stores[0]!.qualificationStatus).toBe("rejected");
      expect(after.entity.verificationStatus).toBe(kind === "initial" ? "rejected" : "verified");
      expect(
        after.history.filter(
          (row) => row.event === "qualification.withdraw" && row.toState === "rejected",
        ),
      ).toHaveLength(kind === "initial" ? 2 : 1);
      expect(after.approvals[0]!.status).toBe("withdrawn");
    },
  );
  it.each(kinds)("归档丢弃 %s 草稿：没有审批、证照removed且保留7天", async (kind) => {
    const f = await draft(kind);
    await h.archive(f);
    await h.invoke(await h.event(f, "store.archived"));
    const after = await h.snapshot(f.entity.id);
    expect(after.rounds[0]).toMatchObject({
      outcome: "discarded",
      closedAt: START,
      submittedAt: null,
      approvalRequestId: null,
    });
    expect(after.docs[0]).toMatchObject({ removedAt: START, verdict: null, effectiveAt: null });
    expect(after.approvals).toEqual([]);
    expect(after.timers).toEqual([]);
    await assertReleased(f.input, later(START, 7));
  });
  it.each(["by_owner", "draft_deleted", "entity_closed", "entity_abandoned"] as ArchiveReason[])(
    "归档原因 %s 按真实同归属终态收尾",
    async (reason) => {
      const f = await draft();
      if (reason === "entity_closed") await h.terminate(f, "closed");
      else if (reason === "entity_abandoned") await h.terminate(f, "abandoned");
      else await h.archive(f, reason);
      await h.invoke(await h.event(f, "store.archived"));
      expect(
        await h.prisma.qualificationSubmission.findUnique({ where: { id: f.round.id } }),
      ).toMatchObject({ outcome: "discarded" });
      await assertReleased(f.input, later(START, 7));
    },
  );
  it.each(kinds)(
    "主体 closed 撤回 %s：真实审批历史/事件/精确决定timer，证照不移除",
    async (kind) => {
      const f = await submitted(kind);
      const execution = await h.unrelatedTimer(f.request.id, f);
      const before = await h.snapshot(f.entity.id);
      const decision = before.timers.filter((t) =>
        t.dedupeKey.startsWith(`sla.breach:approval_request:${f.request.id}:decision:`),
      );
      expect(decision).toHaveLength(1);
      expect(decision[0]!.status).toBe("scheduled");
      expect(f.request.dueAt).not.toBeNull();
      await h.terminate(f);
      await h.invoke(await h.event(f, "entity.closed"));
      const after = await h.snapshot(f.entity.id);
      expect(after.rounds[0]).toMatchObject({
        outcome: "withdrawn",
        closedAt: START,
        approvalRequestId: f.request.id,
      });
      expect(after.approvals[0]).toMatchObject({
        status: "withdrawn",
        isDecidedBySystem: true,
        decidedByStaffId: null,
        decidedAt: START,
        lockVersion: 1,
      });
      expect(after.docs[0]).toMatchObject({ removedAt: null, verdict: null, effectiveAt: null });
      expect(after.timers.find((t) => t.id === decision[0]!.id)).toMatchObject({
        status: "cancelled",
      });
      expect(after.timers.find((t) => t.id === execution.id)).toEqual(
        before.timers.find((t) => t.id === execution.id),
      );
      const history = after.history.slice(before.history.length);
      expect(history.filter((row) => row.machine === "approval_request")).toMatchObject([
        { event: "withdraw", fromState: "pending", toState: "withdrawn", actorType: "system" },
      ]);
      const tenantHistory = history.filter(
        (row) => row.machine === "store" || row.machine === "entity",
      );
      expect(tenantHistory).toHaveLength(kind === "initial" ? 2 : 1);
      expect(
        tenantHistory.every(
          (row) => row.actorType === "system" && row.actorId === null && row.client === null,
        ),
      ).toBe(true);
      if (kind === "change") {
        expect(tenantHistory[0]).toMatchObject({
          machine: "store",
          event: "qualification.change_withdraw",
          fromState: "verified",
          toState: "verified",
        });
        expect(after.entity.verificationStatus).toBe("verified");
      } else {
        expect(after.stores[0]!.qualificationStatus).toBe("unsubmitted");
        expect(after.entity.verificationStatus).toBe(
          kind === "initial" ? "unsubmitted" : "verified",
        );
      }
      const emitted = after.events.slice(before.events.length);
      expect(emitted.map((e) => e.eventType)).toContain("approval.withdrawn");
      expect(
        emitted.filter(
          (e) =>
            e.eventType ===
            (kind === "change"
              ? "store.qualification_change.withdrawn"
              : "store.qualification.withdrawn"),
        ),
      ).toHaveLength(1);
      expect(after.audit.length - before.audit.length).toBe(1);
      await assertReleased(f.input, threeYears(START));
    },
  );
  it.each(kinds)("主体 abandoned 撤回 %s 但保留已提交证照 live", async (kind) => {
    const f = await submitted(kind);
    await h.terminate(f, "abandoned");
    await h.invoke(await h.event(f, "entity.abandoned"));
    const after = await h.snapshot(f.entity.id);
    expect(after.rounds[0]).toMatchObject({ outcome: "withdrawn", closedAt: START });
    expect(after.approvals[0]).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
    expect(after.docs[0]).toMatchObject({ removedAt: null, effectiveAt: null });
    expect(await h.readRef(f.input)).toEqual(live);
  });
  it("abandoned 草稿7天与已终态历史不可再次改写", async () => {
    const f = await draft();
    await h.terminate(f, "abandoned");
    await h.invoke(await h.event(f, "entity.abandoned"));
    await assertReleased(f.input, later(START, 7));
    const before = await h.snapshot(f.entity.id);
    h.clock.advance(400 * DAY);
    await h.invoke(await h.event(f, "entity.abandoned"));
    expect(await h.snapshot(f.entity.id)).toEqual(before);
  });
  it("普通门店归档不能撤回已提交审批或释放证照", async () => {
    const f = await submitted();
    await h.archive(f);
    const before = await h.snapshot(f.entity.id);
    await h.invoke(await h.event(f, "store.archived"));
    const after = await h.snapshot(f.entity.id);
    expect(after.rounds).toEqual(before.rounds);
    expect(after.approvals).toEqual(before.approvals);
    expect(after.docs).toEqual(before.docs);
    expect(after.timers).toEqual(before.timers);
    expect(await h.readRef(f.input)).toEqual(live);
  });
  it("未进入生命周期系统绑定的原商家及system撤回仍明确拒绝并全Tx回滚", async () => {
    const f = await submitted();
    const before = await h.snapshot(f.entity.id);
    for (const ctx of [f.ctx, h.system]) {
      await expect(
        h.tx.run((t) => h.approval.withdraw(t, ctx, { approvalId: f.request.id })),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(await h.snapshot(f.entity.id)).toEqual(before);
    }
  });
});

describe("稳定生命周期锚及所有自然键留存", () => {
  it("Logo、门头/店内、服务图片共用文件仍各有180天真实引用，最后才计算purgeAfter", async () => {
    const o = await h.owner();
    const a = await h.assets(o, true);
    await h.archive(o);
    await h.invoke(await h.event(o, "store.archived"));
    expect(a.inputs).toHaveLength(6);
    for (const input of a.inputs) await assertReleased(input, later(START, 180));
    const same = await h.prisma.fileRef.findMany({ where: { fileId: a.logo.id } });
    expect(same).toHaveLength(3);
    expect(same.every((row) => row.state === "released")).toBe(true);
    expect(await h.prisma.fileObject.findUnique({ where: { id: a.logo.id } })).toMatchObject({
      purgeAfter: later(START, 180),
    });
    expect(h.fake.storage.calls).toEqual([]);
  });
  it.each([
    ["store.archived", "store.draft_deleted"],
    ["store.draft_deleted", "store.archived"],
  ] as const)("独立%s→%s晚到超过原期限仍不顺延7/180天", async (first, second) => {
    const f = await draft();
    const a = await h.assets(f);
    await h.archive(f, "draft_deleted");
    const e1 = await h.event(f, first);
    await h.invoke(e1);
    const before = await h.snapshot(f.entity.id);
    h.clock.advance(500 * DAY);
    const e2 = await h.event(f, second);
    expect(e2.id).not.toBe(e1.id);
    await h.invoke(e2);
    const after = await h.snapshot(f.entity.id);
    expect(after.rounds).toEqual(before.rounds);
    expect(after.docs).toEqual(before.docs);
    expect(after.refs).toEqual(before.refs);
    expect(after.files).toEqual(before.files);
    expect(after.events).toEqual(before.events);
    await assertReleased(f.input, later(START, 7), START);
    for (const input of a.inputs) await assertReleased(input, later(START, 180), START);
  });
  it("草稿7天先释放，主体关闭后真实升级三日历年，反序晚到不缩短不顺延", async () => {
    h.clock.set(new Date("2024-02-29T04:00:00.000Z"));
    const anchor = h.clock.now();
    const f = await draft();
    await h.archive(f, "draft_deleted");
    await h.invoke(await h.event(f, "store.draft_deleted"));
    await assertReleased(f.input, later(anchor, 7), anchor);
    h.clock.advance(DAY);
    const closedAt = h.clock.now();
    await h.terminate(f, "closed", closedAt);
    await h.invoke(await h.event(f, "entity.closed"));
    await assertReleased(f.input, threeYears(closedAt), anchor);
    const before = await h.snapshot(f.entity.id);
    h.clock.advance(1500 * DAY);
    await h.invoke(await h.event(f, "entity.closed"));
    await h.invoke(await h.event(f, "store.archived"));
    await h.invoke(await h.event(f, "store.draft_deleted"));
    expect((await h.snapshot(f.entity.id)).refs).toEqual(before.refs);
    expect((await h.snapshot(f.entity.id)).files).toEqual(before.files);
  });
  it("闰日closed三年按UTC日历计算，历史已移除和有效证照均保留真实更长期", async () => {
    h.clock.set(new Date("2024-02-29T04:00:00.000Z"));
    const anchor = h.clock.now();
    const f = await draft();
    await h.prisma.qualificationDoc.update({
      where: { id: f.doc.id },
      data: { removedAt: anchor },
    });
    const longer = new Date("2032-06-01T00:00:00.000Z");
    await h.tx.run((t) => h.media.release(t, { ...f.input, keepUntil: longer }));
    const old = await h.prisma.fileRef.findFirstOrThrow({ where: { refId: f.doc.id } });
    await h.terminate(f);
    await h.invoke(await h.event(f, "entity.closed"));
    expect(await h.prisma.fileRef.findUnique({ where: { id: old.id } })).toEqual(old);
    const other = await draft();
    await h.terminate(other);
    await h.invoke(await h.event(other, "entity.closed"));
    expect(threeYears(anchor).toISOString()).toBe("2027-03-01T04:00:00.000Z");
    await assertReleased(other.input, threeYears(anchor), anchor);
  });
  it("历史被取代的生效证照也升级三年，历史终态轮次与审批保持原字节事实", async () => {
    const full = profileHarness(h.prisma);
    full.clock.set(START);
    const o = await full.owner();
    const ready = await complete(full, o.viewer);
    await submit(full, o.viewer, ready.submissionId);
    await full.profile.approve(h.system, ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    const doc = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: ready.docId } });
    const f = {
      ...o,
      ctx: o.viewer.ctx,
      doc,
      input: h.ref({ ...o, ctx: o.viewer.ctx }, doc.fileId, "qualification_doc", doc.id, "main"),
    };
    await h.prisma.qualificationDoc.update({
      where: { id: f.doc.id },
      data: { supersededAt: later(START, 1) },
    });
    await h.tx.run((t) => h.media.release(t, { ...f.input, keepUntil: later(START, 7) }));
    const before = await h.snapshot(f.entity.id);
    await h.terminate(f);
    await h.invoke(await h.event(f, "entity.closed"));
    const after = await h.snapshot(f.entity.id);
    expect(after.rounds).toEqual(before.rounds);
    expect(after.approvals).toEqual(before.approvals);
    expect(after.docs).toEqual(before.docs);
    await assertReleased(f.input, threeYears(START));
  });
  it("首次很晚消费仍尊重原media当前clock最低期，后续独立事件不会再延长", async () => {
    const f = await draft();
    const a = await h.assets(f);
    await h.archive(f, "draft_deleted");
    h.clock.advance(500 * DAY);
    const consumedAt = h.clock.now();
    await h.invoke(await h.event(f, "store.draft_deleted"));
    await assertReleased(f.input, later(consumedAt, 7), consumedAt);
    for (const input of a.inputs) await assertReleased(input, later(consumedAt, 30), consumedAt);
    const before = await h.snapshot(f.entity.id);
    h.clock.advance(500 * DAY);
    await h.invoke(await h.event(f, "store.archived"));
    expect((await h.snapshot(f.entity.id)).refs).toEqual(before.refs);
    expect((await h.snapshot(f.entity.id)).files).toEqual(before.files);
  });
  it("缺失真实引用明确失败，草稿丢弃与其他已释放引用全事务回滚", async () => {
    const f = await draft();
    // 只造一个有真实业务列、无file_ref的合法历史缺损；不能假装release成功。
    const a = await h.assets(f);
    const missing = await h.file(f);
    await h.prisma.storeProfileMedia.create({
      data: {
        id: uuidv7(),
        entityId: f.entity.id,
        storeId: f.store.id,
        fileId: missing.id,
        mediaGroup: "promo",
        mediaKind: "image",
        position: 5,
        createActorType: "system",
        createdAt: START,
        updatedAt: START,
      },
    });
    await h.archive(f);
    const before = await h.snapshot(f.entity.id);
    await expect(h.invoke(await h.event(f, "store.archived"))).rejects.toMatchObject({
      error: "FILE_NOT_AVAILABLE",
    });
    expect(await h.snapshot(f.entity.id)).toEqual(before);
    expect(await h.readRef(a.inputs[0]!)).toEqual(live);
  });
});

describe("恢复只处理仍在用档案与真实文件状态", () => {
  it("stored且合法的历史缺失引用由原link真实建立，不用伪造已恢复事实", async () => {
    const o = await h.owner(),
      file = await h.file(o);
    await h.prisma.storeProfile.update({
      where: { storeId: o.store.id },
      data: { logoFileId: file.id },
    });
    const input = h.ref(o, file.id, "store_profile", o.store.id, "logo");
    expect(await h.readRef(input)).toBeNull();
    await h.invoke(await h.event(o, "store.restored"));
    expect(await h.readRef(input)).toEqual(live);
    expect(await h.prisma.fileObject.findUnique({ where: { id: file.id } })).toMatchObject({
      firstLinkedAt: START,
      purgeAfter: null,
    });
  });
  it("stored档案真实relink，保持原firstLinkedAt，重算三列完整度和lockVersion", async () => {
    const o = await h.owner("change"),
      a = await h.assets(o);
    await h.archive(o);
    await h.invoke(await h.event(o, "store.archived"));
    await h.restore(o);
    await h.prisma.storeProfile.update({
      where: { storeId: o.store.id },
      data: { completenessPct: 0, requiredFilled: 0, requiredTotal: 0 },
    });
    const before = await h.snapshot(o.entity.id);
    await h.invoke(await h.event(o, "store.restored"));
    const after = await h.snapshot(o.entity.id);
    for (const input of a.inputs) expect(await h.readRef(input)).toEqual(live);
    expect(
      after.files.every(
        (file) => file.firstLinkedAt?.getTime() === START.getTime() && file.purgeAfter === null,
      ),
    ).toBe(true);
    expect(after.profiles[0]).toMatchObject({
      completenessPct: 87,
      requiredFilled: 13,
      requiredTotal: 15,
    });
    expect(after.profiles[0]!.lockVersion).toBeGreaterThanOrEqual(before.profiles[0]!.lockVersion);
    expect(after.mediaRows).toEqual(before.mediaRows);
    expect(after.services).toEqual(before.services);
    expect(after.rounds).toEqual([]);
    expect(h.fake.storage.calls).toEqual([]);
  });
  it("deleted共用Logo/门头/服务图片清理业务行，未清除图片仍relink且完整度下降", async () => {
    const o = await h.owner("change"),
      a = await h.assets(o, true);
    await h.archive(o);
    await h.invoke(await h.event(o, "store.archived"));
    await h.prisma.fileObject.update({
      where: { id: a.logo.id },
      data: { status: "deleted", deletedAt: START },
    });
    await h.restore(o);
    const before = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: o.store.id },
    });
    h.clock.advance(DAY);
    const now = h.clock.now();
    await h.invoke(await h.event(o, "store.restored"));
    const after = await h.snapshot(o.entity.id);
    expect(after.profiles[0]).toMatchObject({
      logoFileId: null,
      requiredFilled: 11,
      requiredTotal: 15,
      completenessPct: 73,
      lockVersion: before.lockVersion + 1,
    });
    expect(after.mediaRows.find((m) => m.fileId === a.logo.id)).toMatchObject({ removedAt: now });
    expect(after.services[0]).toMatchObject({ removedAt: now });
    expect(after.files.find((file) => file.id === a.logo.id)).toMatchObject({
      status: "deleted",
      deletedAt: START,
    });
    for (const input of a.inputs.filter((input) => input.fileId !== a.logo.id))
      expect(await h.readRef(input)).toEqual(live);
    for (const input of a.inputs.filter((input) => input.fileId === a.logo.id))
      await assertReleased(input, later(START, 180), START);
  });
  it("已removed的档案行不恢复，已丢弃草稿证照不恢复", async () => {
    const f = await draft(),
      a = await h.assets(f);
    await h.archive(f);
    await h.invoke(await h.event(f, "store.archived"));
    await h.prisma.storeProfileMedia.update({
      where: { id: a.rows[0]!.id },
      data: { removedAt: START },
    });
    await h.prisma.storeServiceItem.update({
      where: { id: a.service.id },
      data: { removedAt: START },
    });
    await h.restore(f);
    await h.invoke(await h.event(f, "store.restored"));
    await assertReleased(f.input, later(START, 7), START);
    await assertReleased(
      a.inputs.find((input) => input.refId === a.rows[0]!.id)!,
      later(START, 180),
      START,
    );
    await assertReleased(
      a.inputs.find((input) => input.refId === a.service.id)!,
      later(START, 180),
      START,
    );
    expect(
      await h.prisma.qualificationSubmission.findUnique({ where: { id: f.round.id } }),
    ).toMatchObject({ outcome: "discarded" });
    expect(await h.prisma.qualificationDoc.findUnique({ where: { id: f.doc.id } })).toMatchObject({
      removedAt: START,
    });
  });
  it.each(["pending", "promoting", "deleting", "rejected", "expired"])(
    "%s 文件不伪装已清除，真实link失败保持全部业务事实",
    async (status) => {
      const o = await h.owner(),
        a = await h.assets(o);
      await h.archive(o);
      await h.invoke(await h.event(o, "store.archived"));
      await h.prisma.fileObject.update({
        where: { id: a.logo.id },
        data: { status, rejectReason: status === "rejected" ? "bad_magic" : null },
      });
      await h.restore(o);
      const before = await h.snapshot(o.entity.id);
      await expect(h.invoke(await h.event(o, "store.restored"))).rejects.toMatchObject({
        error: "FILE_NOT_USABLE",
      });
      expect(await h.snapshot(o.entity.id)).toEqual(before);
    },
  );
  it.each(["blocked", "scope_mismatch", "category_mismatch"])(
    "%s 必须保留原owner拒绝，不能吞错删行",
    async (reason) => {
      const o = await h.owner(),
        a = await h.assets(o);
      await h.archive(o);
      await h.invoke(await h.event(o, "store.archived"));
      if (reason === "blocked")
        await h.prisma.fileObject.update({
          where: { id: a.logo.id },
          data: { moderationState: "block" },
        });
      else {
        // file_object归属/分类不可变，构造业务列指向另一合法文件的历史损坏，不修改file归属。
        const other = reason === "scope_mismatch" ? await h.owner() : o;
        const bad = await h.file(
          other,
          reason === "category_mismatch" ? "kyc_license" : "profile_image",
        );
        await h.prisma.storeProfile.update({
          where: { storeId: o.store.id },
          data: { logoFileId: bad.id },
        });
      }
      await h.restore(o);
      const before = await h.snapshot(o.entity.id);
      await expect(h.invoke(await h.event(o, "store.restored"))).rejects.toMatchObject({
        error: "FILE_NOT_USABLE",
      });
      expect(await h.snapshot(o.entity.id)).toEqual(before);
    },
  );
  it.each(["blocked", "scope_mismatch", "category_mismatch"])(
    "deleted但%s 仍拒绝，不能借清除分支吞掉owner错误",
    async (reason) => {
      const o = await h.owner(),
        a = await h.assets(o);
      await h.archive(o);
      await h.invoke(await h.event(o, "store.archived"));
      let fileId = a.logo.id;
      if (reason !== "blocked") {
        const other = reason === "scope_mismatch" ? await h.owner() : o;
        const invalid = await h.file(
          other,
          reason === "category_mismatch" ? "kyc_license" : "profile_image",
        );
        fileId = invalid.id;
        await h.prisma.storeProfile.update({
          where: { storeId: o.store.id },
          data: { logoFileId: fileId },
        });
      }
      await h.prisma.fileObject.update({
        where: { id: fileId },
        data: {
          status: "deleted",
          deletedAt: START,
          ...(reason === "blocked" ? { moderationState: "block" } : {}),
        },
      });
      await h.restore(o);
      const before = await h.snapshot(o.entity.id);
      await expect(h.invoke(await h.event(o, "store.restored"))).rejects.toMatchObject({
        error: reason === "scope_mismatch" ? "FILE_NOT_AVAILABLE" : "FILE_NOT_USABLE",
      });
      expect(await h.snapshot(o.entity.id)).toEqual(before);
      expect(before.profiles[0]!.logoFileId).toBe(fileId);
    },
  );
  it("旧archived到达已恢复门店不会丢新草稿；旧restored到达再归档门店不relink", async () => {
    const f = await draft(),
      a = await h.assets(f);
    await h.archive(f);
    const archived = await h.event(f, "store.archived");
    await h.invoke(archived);
    await h.restore(f);
    const restored = await h.event(f, "store.restored");
    const freshDraft = await h.draft(f);
    const before = await h.snapshot(f.entity.id);
    await h.invoke(archived);
    expect(await h.snapshot(f.entity.id)).toEqual(before);
    expect(freshDraft.round.closedAt).toBeNull();
    await h.archive(f);
    const rearchived = await h.snapshot(f.entity.id);
    await h.invoke(restored);
    expect(await h.snapshot(f.entity.id)).toEqual(rearchived);
    for (const input of a.inputs) await assertReleased(input, later(START, 180), START);
  });
  it("entity终态下的旧restored消息不能恢复档案引用", async () => {
    const o = await h.owner(),
      a = await h.assets(o);
    await h.archive(o);
    await h.invoke(await h.event(o, "store.archived"));
    await h.terminate(o);
    const before = await h.snapshot(o.entity.id);
    await h.invoke(await h.event(o, "store.restored"));
    expect(await h.snapshot(o.entity.id)).toEqual(before);
    await assertReleased(a.inputs[0]!, later(START, 180));
  });
});

describe("原事务回滚、完整锁图及真实双连接竞争", () => {
  it("真实资格决定与终态收尾竞争：审核不能越过主体终态，审批仅系统撤回一次", async () => {
    const full = profileHarness(h.prisma);
    const o = await full.owner();
    const ready = await complete(full, o.viewer);
    await submit(full, o.viewer, ready.submissionId);
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    const owner = { ...o, ctx: o.viewer.ctx };
    await h.terminate(owner);
    const event = await h.event(owner, "entity.closed");
    const connection = createPrismaClient({
      connectionString: testDatabaseUrl(db.name),
      max: 1,
    });
    try {
      const decider = profileHarness(connection);
      const results = await Promise.allSettled([
        h.invoke(event),
        decider.profile.approve(h.system, ready.submissionId, {
          lockVersion: 0,
          confirm: { roundNo: 1 },
        }),
      ]);
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("rejected");
      if (results[1]!.status === "rejected") {
        expect(["APPROVAL_NOT_PENDING", "PRECONDITION_CHANGED"]).toContain(
          results[1]!.reason.error,
        );
      }
      const after = await h.snapshot(o.entity.id);
      expect(after.approvals[0]).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
      expect(after.rounds[0]).toMatchObject({ outcome: "withdrawn" });
      expect(
        after.history.filter(
          (row) => row.subjectId === round.approvalRequestId && row.fromState === "pending",
        ),
      ).toHaveLength(1);
      expect(
        after.events.filter((row) => row.eventType === "store.qualification.approved"),
      ).toEqual([]);
      expect(after.docs.every((doc) => doc.effectiveAt === null)).toBe(true);
    } finally {
      await connection.$disconnect();
    }
  });
  it("恢复等待真实file410锁后重读赢家deleted状态，清理业务列而非误relink", async () => {
    const o = await h.owner("change"),
      a = await h.assets(o, true);
    await h.archive(o);
    await h.invoke(await h.event(o, "store.archived"));
    await h.restore(o);
    const event = await h.event(o, "store.restored");
    const connection = createPrismaClient({
      connectionString: testDatabaseUrl(db.name),
      max: 2,
    });
    const other = createTxRunner({ prisma: connection, appEnv: "test" });
    let release!: () => void,
      locked!: () => void,
      waiterPid = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = other.run(async (t) => {
      await lockRows(t, "file_object", [a.logo.id]);
      locked();
      await gate;
      await t.fileObject.update({
        where: { id: a.logo.id },
        data: { status: "deleted", deletedAt: START },
      });
    });
    let waiter: Promise<void> | undefined;
    try {
      await ready;
      waiter = h.tx.run(async (t) => {
        [{ pid: waiterPid }] = await t.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::int AS pid",
        );
        await h.lifecycle.onTenantLifecycle(t, event);
      });
      const outcome = waiter.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.waitFor(
        async () => {
          expect(waiterPid).toBeGreaterThan(0);
          const [row] = await connection.$queryRawUnsafe<Array<{ waiting: boolean }>>(
            "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting",
            waiterPid,
          );
          expect(row!.waiting).toBe(true);
        },
        { timeout: 2000, interval: 20 },
      );
      release();
      await holder;
      expect(await outcome).toEqual({ ok: true });
      const after = await h.snapshot(o.entity.id);
      expect(after.profiles[0]!.logoFileId).toBeNull();
      expect(after.services[0]!.removedAt).toEqual(START);
      expect(after.mediaRows.find((row) => row.fileId === a.logo.id)!.removedAt).toEqual(START);
      expect(after.files.find((file) => file.id === a.logo.id)).toMatchObject({
        status: "deleted",
        deletedAt: START,
      });
      for (const input of a.inputs.filter((input) => input.fileId === a.logo.id))
        await assertReleased(input, later(START, 180), START);
    } finally {
      release();
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
      await connection.$disconnect();
    }
  });
  it("外层sentinel回滚round/approval/tenant历史/media/timer/audit/outbox全部，随后可重试", async () => {
    const f = await submitted();
    await h.terminate(f);
    const e = await h.event(f, "entity.closed"),
      before = await h.snapshot(f.entity.id);
    const sentinel = new Error("LIFECYCLE_OUTER_ROLLBACK");
    await expect(
      h.tx.run(async (t) => {
        await h.lifecycle.onTenantLifecycle(t, e);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(await h.snapshot(f.entity.id)).toEqual(before);
    await h.invoke(e);
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: f.request.id } }),
    ).toMatchObject({ status: "withdrawn" });
    await assertReleased(f.input, threeYears(START));
  });
  it("真实第二事件已写后抛错，不mock Prisma create，所有领域写回滚", async () => {
    const f = await submitted();
    await h.terminate(f);
    const before = await h.snapshot(f.entity.id),
      e = await h.event(f, "entity.closed");
    let emitted = 0;
    const realEmit = h.events.emit;
    const spy = vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      const result = await realEmit(...args);
      if (result.emitted && ++emitted === 2) throw new Error("AFTER_SECOND_REAL_EVENT");
      return result;
    });
    try {
      await expect(h.tx.run((t) => h.lifecycle.onTenantLifecycle(t, e))).rejects.toThrow(
        "AFTER_SECOND_REAL_EVENT",
      );
      expect(emitted).toBe(2);
      expect(await h.snapshot(f.entity.id)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
  it("同主体两change轮次/全部档案文件预锁，原锁序断言及真实两个审批均成功", async () => {
    const o = await h.owner("change"),
      o2 = await secondStore(o);
    const f1 = await h.submitted(await h.draft(o, "change"));
    const f2 = await h.submitted(await h.draft(o2, "change"));
    const a1 = await h.assets(o),
      a2 = await h.assets(o2);
    await h.terminate(o);
    await h.archive(o2, "entity_closed");
    await h.invoke(await h.event(o, "entity.closed"));
    expect((await h.snapshot(o.entity.id)).approvals.map((a) => a.status)).toEqual([
      "withdrawn",
      "withdrawn",
    ]);
    await assertReleased(f1.input, threeYears(START));
    await assertReleased(f2.input, threeYears(START));
    for (const own of [o, o2]) await h.invoke(await h.event(own, "store.archived"));
    for (const input of [...a1.inputs, ...a2.inputs])
      await assertReleased(input, later(START, 180));
  });
  it("低位审批锁等待期间新增候选门店/轮次，整Tx拒绝而不补低锁", async () => {
    const f = await submitted("change");
    await h.terminate(f);
    const e = await h.event(f, "entity.closed");
    const connection = createPrismaClient({
      connectionString: testDatabaseUrl(db.name),
      max: 2,
    });
    const other = createTxRunner({ prisma: connection, appEnv: "test" });
    let release!: () => void,
      locked!: () => void,
      waiterPid = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = other.run(async (t) => {
      await lockRows(t, "approval_request", [f.request.id]);
      locked();
      await gate;
    });
    let waiter: Promise<void> | undefined;
    try {
      await ready;
      waiter = h.tx.run(async (t) => {
        [{ pid: waiterPid }] = await t.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::int AS pid",
        );
        await h.lifecycle.onTenantLifecycle(t, e);
      });
      // 捕获结果立即挂处理，避免预期拒绝成为未处理 Promise。
      const outcome = waiter.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.waitFor(
        async () => {
          expect(waiterPid).toBeGreaterThan(0);
          const [row] = await connection.$queryRawUnsafe<Array<{ waiting: boolean }>>(
            "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting",
            waiterPid,
          );
          expect(row!.waiting).toBe(true);
        },
        { timeout: 2000, interval: 20 },
      );
      const newOwner = await secondStore(f);
      const added = await h.draft(newOwner, "change");
      await h.archive(newOwner, "entity_closed");
      const before = await h.snapshot(f.entity.id);
      release();
      await holder;
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ error: "PRECONDITION_CHANGED" });
      expect(await h.snapshot(f.entity.id)).toEqual(before);
      expect(added.round.closedAt).toBeNull();
      await h.invoke(e);
      expect((await h.snapshot(f.entity.id)).rounds.every((r) => r.closedAt !== null)).toBe(true);
    } finally {
      release();
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
      await connection.$disconnect();
    }
  });
  it("两个真实连接同时系统收尾，审批仅一轮withdraw和一个领域事件", async () => {
    const f = await submitted("change");
    await h.terminate(f);
    const e1 = await h.event(f, "entity.closed"),
      e2 = await h.event(f, "entity.closed");
    const connection = createPrismaClient({
      connectionString: testDatabaseUrl(db.name),
      max: 1,
    });
    const other = createTxRunner({ prisma: connection, appEnv: "test" });
    try {
      const results = await Promise.allSettled([
        h.invoke(e1),
        other.run((t) => h.lifecycle.onTenantLifecycle(t, e2)),
      ]);
      for (const result of results) {
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ error: "PRECONDITION_CHANGED" });
      }
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      const after = await h.snapshot(f.entity.id);
      expect(
        after.history.filter((r) => r.subjectId === f.request.id && r.event === "withdraw"),
      ).toHaveLength(1);
      expect(
        after.events.filter((r) => r.eventType === "store.qualification_change.withdrawn"),
      ).toHaveLength(1);
      expect(after.approvals[0]!.status).toBe("withdrawn");
    } finally {
      await connection.$disconnect();
    }
  });
});

describe("真实worker实例作用域与原outbox交付", () => {
  it("未attach/重复attach/close后的唯一subscriber明确拒绝，各scope独立", async () => {
    const a = createProfileLifecycleAssembly(assembleForTest({ entry: "worker" }));
    const b = createProfileLifecycleAssembly(assembleForTest({ entry: "worker" }));
    const o = await h.owner();
    const e = await h.event(o, "entity.closed");
    const handleA = a.assembly.subscribers.find(
      (s) => s.name === "profile.onTenantLifecycle",
    )!.handle;
    const handleB = b.assembly.subscribers.find(
      (s) => s.name === "profile.onTenantLifecycle",
    )!.handle;
    try {
      await expect(h.tx.run((t) => handleA(t, e))).rejects.toThrow();
      a.attach(h.lifecycle);
      b.attach(h.lifecycle);
      expect(() => a.attach(h.lifecycle)).toThrow();
      a.close();
      await expect(h.tx.run((t) => handleA(t, e))).rejects.toThrow();
      await expect(h.tx.run((t) => handleB(t, e))).resolves.toBeUndefined();
      expect(() => a.attach(h.lifecycle)).toThrow();
    } finally {
      a.close();
      b.close();
    }
  });
  it.each(types)("%s 经真实emit/expand/dispatch/consume完成，重复delivery stale", async (type) => {
    const worker = (lifecycleWorker ??= buildWorker());
    const f = await draft();
    if (type === "entity.closed") await h.terminate(f);
    else if (type === "entity.abandoned") await h.terminate(f, "abandoned");
    else if (type !== "store.restored")
      await h.archive(f, type === "store.draft_deleted" ? "draft_deleted" : "by_owner");
    const ref = await queued(f, await h.event(f, type), worker);
    expect(await worker.one.consume(ref)).toBe("done");
    const before = await h.snapshot(f.entity.id);
    expect(await worker.one.consume(ref)).toBe("stale");
    expect(await h.snapshot(f.entity.id)).toEqual(before);
    expect(
      await h.prisma.outboxDelivery.findUnique({
        where: {
          outboxEventId_subscriber: { outboxEventId: ref.eventId, subscriber: ref.subscriber },
        },
      }),
    ).toMatchObject({ status: "done", attempts: 0, consumedAt: expect.any(Date) });
  });
  it("两个真实worker互不借用API实例，关闭一个后另一个仍消费且双投递只有一次副作用", async () => {
    const a = buildWorker(),
      b = buildWorker();
    expect(a.one.assembly).not.toBe(b.one.assembly);
    const f = await submitted();
    await h.terminate(f);
    const ref = await queued(f, await h.event(f, "entity.closed"), a);
    const results = await Promise.all([a.one.consume(ref), b.one.consume(ref)]);
    expect(results.sort()).toEqual(["done", "stale"]);
    const after = await h.snapshot(f.entity.id);
    expect(
      after.events.filter((e) => e.eventType === "store.qualification.withdrawn"),
    ).toHaveLength(1);
    a.one.closeProfile?.();
    const next = await draft();
    await h.archive(next);
    const nextRef = await queued(next, await h.event(next, "store.archived"), b);
    expect(await b.one.consume(nextRef)).toBe("done");
    expect(
      await h.prisma.qualificationSubmission.findUnique({ where: { id: next.round.id } }),
    ).toMatchObject({ outcome: "discarded" });
  });
  it("真实消费在第二事件写入后失败，delivery单独retry而业务全回滚；原派发重试成功", async () => {
    const f = await submitted();
    await h.terminate(f);
    const e = await h.event(f, "entity.closed");
    let eventsWritten = 0;
    const realEmit = h.events.emit;
    const spy = vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      const result = await realEmit(...args);
      if (result.emitted && ++eventsWritten === 2)
        throw new Error("OUTBOX_REAL_SECOND_EVENT_ROLLBACK");
      return result;
    });
    const scope = createProfileLifecycleAssembly(assembleForTest({ entry: "worker" }));
    scope.attach(h.lifecycle);
    const events = createEvents({ tx: h.tx, clock: h.clock, assembly: scope.assembly });
    const refs: DeliveryRef[] = [];
    const alerts = { raise: async () => undefined };
    const dispatch = () =>
      dispatchDue({
        tx: h.tx,
        subscribers: events.subscribers,
        alerts,
        channel: {
          downForMs: () => 0,
          enqueue: async (_queue, _id, raw) => {
            const ref = raw as DeliveryRef;
            if (ref.subscriber === "profile.onTenantLifecycle") refs.push(ref);
          },
        },
      });
    try {
      const eventId = await h.emit(f, e, events);
      eventsWritten = 0;
      await events.expand();
      await dispatch();
      const ref = refs.find((r) => r.eventId === eventId)!;
      expect(ref).toBeDefined();
      const before = await h.snapshot(f.entity.id);
      expect(
        await consumeDelivery({ tx: h.tx, subscribers: events.subscribers, alerts }, ref),
      ).toBe("retry");
      expect(eventsWritten).toBe(2);
      expect(await h.snapshot(f.entity.id)).toEqual(before);
      const delivery = await h.prisma.outboxDelivery.findUniqueOrThrow({
        where: { outboxEventId_subscriber: { outboxEventId: eventId, subscriber: ref.subscriber } },
      });
      expect(delivery).toMatchObject({ status: "retry", attempts: 1, consumedAt: null });
      expect(delivery.lastError).toContain("OUTBOX_REAL_SECOND_EVENT_ROLLBACK");
      spy.mockRestore();
      // 到期资格是基础设施时间，显式推进本条retry行而不睡眠/放宽退避策略。
      await h.prisma.outboxDelivery.update({
        where: { outboxEventId_subscriber: { outboxEventId: eventId, subscriber: ref.subscriber } },
        data: { nextAttemptAt: new Date(0) },
      });
      const worker = buildWorker();
      await worker.one.dispatch();
      const retry = worker.deliveries.find(
        (r) => r.eventId === eventId && r.subscriber === ref.subscriber,
      )!;
      expect(retry.dispatchNo).toBe(ref.dispatchNo + 1);
      expect(await worker.one.consume(retry)).toBe("done");
      expect(
        await h.prisma.approvalRequest.findUnique({ where: { id: f.request.id } }),
      ).toMatchObject({ status: "withdrawn" });
      expect(await worker.one.consume(ref)).toBe("stale");
    } finally {
      spy.mockRestore();
      scope.close();
    }
  });
});
