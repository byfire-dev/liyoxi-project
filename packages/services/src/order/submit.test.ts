import { beforeAll, describe, expect, it } from "vitest";
import { OrderCreateResultSchema } from "@liyoxi/contract";
import { useSeededDatabase, priceDrama, openTerm } from "../testing/index.js";
import { createOrderService } from "./service.js";
import { uuidv7 } from "../kernel/index.js";
import { harness, buyer, drama, body, version, residual } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
const empty = { orders: 0, items: 0, holds: 0, consents: 0 };
describe("报价与原子订购", { timeout: 60000 }, () => {
  it.each(["full", "parallel"] as const)(
    "%s：逐部冻结、账号、状态历史、审计、选剧清理和真实定时器",
    async (gate) => {
      const b = await buyer(h, { gate }),
        ds = await Promise.all([101, 102, 103].map((p) => drama(h, p))),
        input = await body(
          h,
          b,
          ds.map((d) => d.id),
          true,
        );
      const quoted = await h.order.quote(b.actor, {
        dramaIds: input.dramaIds,
        isTopModel: true,
        channelAccountIds: input.channelAccountIds,
      });
      expect(quoted.blockers).toEqual([]);
      for (const d of ds)
        await h.prisma.cartItem.create({
          data: {
            id: uuidv7(),
            entityId: b.entity.id,
            storeId: b.store.id,
            dramaId: d.id,
            addedByUserId: b.user.id,
            listPricePoints: 101,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
      const out = await h.order.create(b.actor, input);
      expect(OrderCreateResultSchema.safeParse(out).success).toBe(true);
      expect(out.replayed).toBe(false);
      expect(out.orderNo).toMatch(/^LYX\d{13}$/);
      expect(out.items.map((i) => i.chargePoints)).toEqual(
        quoted.expect.items.map((i) => i.chargePoints),
      );
      expect(out.totalChargePoints).toBe(quoted.totalChargePoints);
      expect(out.subStatus).toBe(gate === "full" ? "starting" : "qualification_reviewing");
      expect(out.items.every((i) => i.posterUrl?.url)).toBe(true);
      expect(out.items.every((i) => i.accounts.length === 1)).toBe(true);
      const ids = [out.orderId, ...out.items.map((i) => i.orderItemId)];
      expect(await h.prisma.statusTransition.count({ where: { subjectId: { in: ids } } })).toBe(4);
      expect(await h.prisma.auditLog.count({ where: { targetId: { in: ids } } })).toBe(4);
      expect(
        await h.prisma.outboxEvent.count({
          where: { eventType: "order.submitted", aggregateId: out.orderId },
        }),
      ).toBe(1);
      expect(await h.prisma.cartItem.count({ where: { storeId: b.store.id } })).toBe(0);
      expect(await h.prisma.orderItemPlacement.count({ where: { orderItemId: { in: ids } } })).toBe(
        0,
      );
      expect(await h.prisma.deliveryTicket.count({ where: { dramaOrderId: out.orderId } })).toBe(0);
      const timer = await h.prisma.timer.findFirst({ where: { subjectId: out.orderId } });
      expect(timer?.status ?? null).toBe(gate === "full" ? "scheduled" : null);
      expect(out.pointsEvents).toEqual([
        {
          opType: "hold",
          occurredAt: out.submittedAt,
          points: out.totalChargePoints,
          planPoints: out.totalChargePoints,
          addonPoints: 0,
        },
      ]);
      expect(out.agreements).toHaveLength(1);
      expect(out.items[0]!.timeline.map((t) => t.state)).toEqual([
        "done",
        "current",
        "todo",
        "todo",
        "todo",
        "todo",
        "todo",
        "todo",
        "todo",
      ]);
    },
  );
  it("第二部变价：整单新价 details，第一部冻结及同意也回滚", async () => {
    const b = await buyer(h),
      ds = await Promise.all([101, 102, 103].map((p) => drama(h, p))),
      input = await body(
        h,
        b,
        ds.map((d) => d.id),
      );
    h.clock.advance(1);
    await priceDrama(h, { dramaId: ds[1]!.id, points: 201, staffId: ds[1]!.createdByStaffId });
    const q = await h.order.quote(b.actor, { dramaIds: input.dramaIds, isTopModel: false });
    await expect(h.order.create(b.actor, input)).rejects.toMatchObject({
      error: "QUOTE_CHANGED",
      details: { kind: "points", totalChargePoints: q.totalChargePoints, items: q.expect.items },
    });
    expect(await residual(h, b.entity.id)).toEqual(empty);
  });
  it("P/R变动但S相抵相同：immutable整单标题守卫仍整笔QUOTE_CHANGED", async () => {
    const b = await buyer(h),
      d = await drama(h, 200),
      input = await body(h, b, [d.id]);
    const real = h.ledger.hold;
    let once = false;
    const order = createOrderService({
      ...h.deps,
      ledger: {
        ...h.ledger,
        hold: async (tx, arg) => {
          if (!once) {
            once = true;
            h.clock.advance(1);
            await priceDrama(h, { dramaId: d.id, points: 180, staffId: d.createdByStaffId });
            await tx.subscriptionTerm.update({
              where: { id: b.term!.id },
              data: { discountBp: 10000 },
            });
          }
          return real(tx, arg);
        },
      },
    });
    await expect(order.create(b.actor, input)).rejects.toMatchObject({
      error: "QUOTE_CHANGED",
      details: {
        kind: "points",
        totalChargePoints: 180,
        items: [{ dramaId: d.id, chargePoints: 180 }],
      },
    });
    expect(await residual(h, b.entity.id)).toEqual(empty);
    expect(
      (await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: b.term!.id } })).discountBp,
    ).toBe(9000);
  });
  it("Tc报价后切入折扣不同的新周期：锁内重算整单，推进与同意全部回滚", async () => {
    const b = await buyer(h),
      d = await drama(h, 101);
    const next = await openTerm(h, { entityId: b.entity.id, planCode: "basic", after: b.term! });
    const input = await body(h, b, [d.id]),
      real = h.ledger.hold;
    const order = createOrderService({
      ...h.deps,
      ledger: {
        ...h.ledger,
        hold: async (tx, arg) => {
          h.clock.set(new Date(next.term.startsAt.getTime() + 1));
          return real(tx, arg);
        },
      },
    });
    await expect(order.create(b.actor, input)).rejects.toMatchObject({
      error: "QUOTE_CHANGED",
      details: {
        kind: "points",
        totalChargePoints: 101,
        items: [{ dramaId: d.id, chargePoints: 101 }],
      },
    });
    expect(await residual(h, b.entity.id)).toEqual(empty);
    expect(
      (await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: next.term.id } })).status,
    ).toBe("scheduled");
    expect(
      (await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: b.entity.id } }))
        .currentSubscriptionTermId,
    ).toBe(b.term!.id);
    h.clock.set(new Date("2026-01-05T04:00:00Z"));
  });
  it("整单积分不足：已冻部分加回 pre-hold余额，details为ΣS，零残留", async () => {
    const b = await buyer(h),
      ds = await Promise.all([4000, 4000, 4000].map((p) => drama(h, p))),
      input = await body(
        h,
        b,
        ds.map((d) => d.id),
      );
    await expect(h.order.create(b.actor, input)).rejects.toMatchObject({
      error: "POINTS_INSUFFICIENT",
      details: { requiredPoints: 10800, spendablePoints: 6600, shortfallPoints: 4200 },
    });
    expect(await residual(h, b.entity.id)).toEqual(empty);
  });
  it("Tc 跨零点到 Tf：同意保持原时刻，提交/状态/流水/定时器采用真实hold时刻", async () => {
    h.clock.set(new Date("2026-02-02T15:59:59.000Z"));
    const b = await buyer(h),
      d = await drama(h),
      input = await body(h, b, [d.id]);
    const real = h.ledger.hold;
    const order = createOrderService({
      ...h.deps,
      ledger: {
        ...h.ledger,
        hold: async (tx, arg) => {
          h.clock.advance(2000);
          return real(tx, arg);
        },
      },
    });
    const result = await order.create(b.actor, input);
    expect(result.agreements[0]!.consentedAt).toBe("2026-02-02T15:59:59.000Z");
    expect(result.submittedAt).toBe("2026-02-02T16:00:01.000Z");
    expect(result.items[0]!.phaseChangedAt).toBe(result.submittedAt);
    const histories = await h.prisma.statusTransition.findMany({
      where: { subjectId: { in: [result.orderId, result.items[0]!.orderItemId] } },
    });
    expect(histories.every((x) => x.occurredAt.toISOString() === result.submittedAt)).toBe(true);
    const op = await h.prisma.ledgerOperation.findFirstOrThrow({
      where: {
        pointHoldId: (
          await h.prisma.orderItem.findUniqueOrThrow({
            where: { id: result.items[0]!.orderItemId },
          })
        ).pointHoldId,
      },
    });
    expect(op.bizDate.toISOString().slice(0, 10)).toBe("2026-02-03");
  });
  it("hold后Tv版本切换：标准stale，真实consent/冻结整笔回滚", async () => {
    h.clock.set(new Date("2026-03-02T15:59:59.000Z"));
    const b = await buyer(h),
      d = await drama(h),
      input = await body(h, b, [d.id]),
      newVersion = await h.make.agreementVersion({
        status: "pending",
        effectiveAt: new Date("2026-03-02T16:00:00Z"),
      });
    const real = h.ledger.hold;
    const order = createOrderService({
      ...h.deps,
      ledger: {
        ...h.ledger,
        hold: async (tx, arg) => {
          const r = await real(tx, arg);
          h.clock.advance(2000);
          return r;
        },
      },
    });
    await expect(order.create(b.actor, input)).rejects.toMatchObject({
      error: "AGREEMENT_VERSION_STALE",
      details: { agreementKey: "custom_license", currentAgreementVersionId: newVersion.id },
    });
    expect(await residual(h, b.entity.id)).toEqual(empty);
  });
});
