import { afterEach, expect, it, vi } from "vitest";
import type { PlanOrderContent } from "@liyoxi/contract";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createNotices } from "../config/index.js";
import { describePaymentOrders } from "../billing/index.js";
import {
  createClock,
  createDocsAdminFixture,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createDocs, seedPlaceholderAgreementVersions } from "../docs/index.js";
import type { ConsentSigner } from "../docs/index.js";
import { createFlow } from "../flow/index.js";

const handle = useSeededDatabase("services", { max: 1 });
let fixture: ReturnType<typeof createDocsAdminFixture> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

it("已签付款协议批量真实标题：前任老板/本主体、重复去重、跨主体和缺单隔离、clerk零交易键与零标题调用", async () => {
  const db = await handle.prisma(),
    clock = createClock(new Date("2040-01-09T02:00:00Z"));
  const h = createDocsAdminFixture(db, null, { clock });
  fixture = h;
  const staff = await h.actor(),
    pdf = await h.file(staff, "pdf");
  if (!pdf.sha256) throw new Error("本轮协议PDF缺真实字节哈希");
  const keys = ["user", "privacy", "member", "points", "custom_license", "ad_service"];
  await h.tx.run((tx) =>
    seedPlaceholderAgreementVersions(
      tx,
      staff.identity,
      { clock, notices: createNotices({ clock, events: h.events }), appEnv: "test" },
      {
        staffId: staff.staff.staff.id,
        files: Object.fromEntries(
          keys.map((key) => [key, { pdfFileId: pdf.id, sha256: pdf.sha256! }]),
        ),
      },
    ),
  );
  const versions = await h.docs.currentVersions(db);
  const current = await h.make.merchant({ verified: true }),
    former = await h.make.merchantUser(),
    clerk = await h.make.merchantUser();
  const foreign = await h.make.merchant({ verified: true });
  const plan = await db.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const revision = await db.planRevision.findFirstOrThrow({
    where: { planId: plan.id, cancelledAt: null },
    orderBy: { revisionNo: "desc" },
  });
  const content = (months: number, planName?: string) =>
    ({
      v: 1,
      kind: "plan",
      planId: plan.id,
      ...(planName === undefined ? {} : { planName }),
      planRevisionId: revision.id,
      months,
      cyclePriceFen: revision.monthlyFeeFen * months,
      payFen: revision.monthlyFeeFen * months,
      monthlyPoints: revision.monthlyPoints,
      discountBp: 10000,
      promo: null,
      quotedAt: clock.now().toISOString(),
    }) satisfies PlanOrderContent;
  // Initial pending orders suffice for this read model; no payment/fulfillment state is forged.
  const first = await h.make.billingOrder({
    entityId: current.entity.id,
    storeId: current.store.id,
    status: "pending_payment",
    type: "plan_new",
    amountFen: revision.monthlyFeeFen * 2,
    contentSnapshot: content(2, "签署时专业版"),
  });
  const flow = createFlow({ assembly: h.assembly, clock, events: h.events });
  await h.tx.run(async (tx) => {
    await lockRows(tx, "billing_order", [first.id]);
    await flow.transition(
      tx,
      createIdentityContext({
        actor: { type: "merchant", id: current.user.id, client: "weapp", role: "owner" },
        entityId: current.entity.id,
        storeId: current.store.id,
      }),
      {
        machine: "billing_order",
        stateField: "status",
        id: first.id,
        event: "billing_order.cancel",
        ref: "08:166",
        reasonCode: "user",
        set: { cancelled_at: clock.now(), cancel_reason: "user" },
        audit: {
          stream: "activity",
          category: "payment",
          action: "billing.order.cancel",
          summary: "老板取消未支付付款单",
          target: { type: "billing_order", id: first.id },
          entityId: current.entity.id,
          storeId: current.store.id,
        },
        emit: {
          type: "billing_order.cancelled",
          payload: {
            v: 1,
            billingOrderId: first.id,
            entityId: current.entity.id,
            cancelReason: "user",
          },
        },
      },
    );
  });
  expect((await db.billingOrder.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
    "cancelled",
  );
  const latest = await h.make.billingOrder({
    entityId: current.entity.id,
    storeId: current.store.id,
    status: "pending_payment",
    type: "plan_renew",
    amountFen: revision.monthlyFeeFen * 3,
    contentSnapshot: content(3),
  });
  const outside = await h.make.billingOrder({
    entityId: foreign.entity.id,
    storeId: foreign.store.id,
    status: "pending_payment",
    amountFen: revision.monthlyFeeFen * 9,
    contentSnapshot: content(9, "不得泄露的别主体标题"),
  });
  type User = typeof current.user;
  function signer(user: User, role: ConsentSigner["role"]): ConsentSigner {
    if (!user.phoneEnc || !user.phoneMask) throw new Error("本轮签署人手机号夹具缺失");
    return {
      merchantUserId: user.id,
      phoneEnc: user.phoneEnc,
      phoneMask: user.phoneMask,
      operatorNameMask: "本轮签署人",
      role,
      appid: "wx0000000000000001",
      openidHmac: new Uint8Array(32).fill(7),
    };
  }
  const identity = (user: User, role: "owner" | "clerk") =>
    createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role },
      entityId: current.entity.id,
      storeId: current.store.id,
    });
  const personal = (user: User, role: "owner" | "clerk") =>
    h.tx.run((tx) =>
      h.docs.assertConsents(tx, identity(user, role), {
        scene: "login",
        signer: signer(user, role),
        consents: ["user", "privacy"].map((key) => ({ agreementVersionId: versions.get(key)!.id })),
      }),
    );
  await personal(current.user, "owner");
  await personal(clerk, "clerk");
  const consent = (user: User, order: typeof first) =>
    h.tx.run((tx) =>
      h.docs.assertConsents(tx, identity(user, "owner"), {
        scene: "plan_purchase",
        signer: signer(user, "owner"),
        consents: ["member", "points"].map((key) => ({
          agreementVersionId: versions.get(key)!.id,
        })),
        entity: {
          entityId: current.entity.id,
          entityName: current.entity.name,
          usccEnc: current.entity.usccEnc,
          usccMask: current.entity.usccMask,
          storeId: current.store.id,
        },
        biz: { type: "billing_order", id: order.id, no: order.orderNo },
      }),
    );
  // The historical signer is a different account from the current entity viewer.
  const oldConsent = await consent(former, first);
  clock.advance(1);
  const newConsent = await consent(current.user, latest);
  expect(
    (
      await db.agreementConsent.findUniqueOrThrow({
        where: { id: oldConsent.consents[0]!.agreementConsentId },
      })
    ).merchantUserId,
  ).toBe(former.id);
  expect(former.id).not.toBe(current.user.id);

  const calls: Array<{ entityId: string; orderNos: string[] }> = [];
  async function titles(tx: Tx, entityId: string, orderNos: readonly string[]) {
    calls.push({ entityId, orderNos: [...orderNos] });
    const orders = vi.spyOn(tx.billingOrder, "findMany"),
      single = vi.spyOn(tx.billingOrder, "findUnique");
    const plans = vi.spyOn(tx.plan, "findMany"),
      singlePlan = vi.spyOn(tx.plan, "findUnique");
    try {
      const descriptions = await describePaymentOrders(tx, entityId, orderNos);
      expect(orders).toHaveBeenCalledTimes(orderNos.length ? 1 : 0);
      expect(single).not.toHaveBeenCalled();
      expect(singlePlan).not.toHaveBeenCalled();
      expect(plans.mock.calls.length).toBeLessThanOrEqual(1);
      if (orderNos.length) {
        expect(orders.mock.calls[0]![0]).toMatchObject({
          where: { entityId, orderNo: { in: expect.arrayContaining([...new Set(orderNos)]) } },
        });
        const filter = orders.mock.calls[0]![0]?.where?.orderNo;
        if (typeof filter !== "object" || filter === null || !Array.isArray(filter.in))
          throw new Error("批量标题必须使用单次IN查询");
        expect(filter.in).toHaveLength(new Set(orderNos).size);
      }
      return descriptions;
    } finally {
      orders.mockRestore();
      single.mockRestore();
      plans.mockRestore();
      singlePlan.mockRestore();
    }
  }
  const docs = createDocs({ tx: h.tx, clock, describePaymentOrders: titles });
  const tables = [
    "billing_order",
    "payment_txn",
    "plan",
    "plan_revision",
    "agreement",
    "agreement_version",
    "agreement_consent",
    "merchant_user",
    "entity",
    "audit_log",
    "outbox_event",
    "timer",
  ];
  const before = await snapshotTables(db, tables);
  const missing = "FK204001090999999";
  const described = await h.tx.run((tx) =>
    titles(tx, current.entity.id, [
      first.orderNo,
      latest.orderNo,
      first.orderNo,
      outside.orderNo,
      missing,
    ]),
  );
  expect(described).toHaveLength(2);
  expect(described).toEqual(
    expect.arrayContaining([
      {
        orderNo: first.orderNo,
        paymentOrderId: first.id,
        type: "plan_new",
        title: "开通签署时专业版 · 2 个月",
      },
      {
        orderNo: latest.orderNo,
        paymentOrderId: latest.id,
        type: "plan_renew",
        title: `续费${plan.name} · 3 个月`,
      },
    ]),
  );
  expect(JSON.stringify(described)).not.toContain("不得泄露");
  const owner = await docs.listSignedAgreements(
    { role: "owner", merchantUserId: current.user.id, entityId: current.entity.id },
    { limit: 20 },
  );
  if (owner.viewerRole !== "owner") throw new Error("本轮老板视图形状错误");
  expect(owner.items.map((item) => item.agreementKey)).toEqual([
    "member",
    "points",
    "user",
    "privacy",
  ]);
  for (const key of ["member", "points"]) {
    const row = owner.items.find((item) => item.agreementKey === key)!;
    expect(row).toMatchObject({
      consentedVersion: { agreementVersionId: versions.get(key)!.id },
      isCurrentVersionConsented: true,
      firstConsent: {
        bizType: "billing_order",
        bizNo: first.orderNo,
        bizTitle: "开通签署时专业版 · 2 个月",
        consentNo: oldConsent.consents.find((item) => item.agreementKey === key)!.consentNo,
      },
      latestConsent: {
        bizType: "billing_order",
        bizNo: latest.orderNo,
        bizTitle: `续费${plan.name} · 3 个月`,
        consentNo: newConsent.consents.find((item) => item.agreementKey === key)!.consentNo,
      },
    });
  }
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({
    entityId: current.entity.id,
    orderNos: expect.arrayContaining([first.orderNo, latest.orderNo]),
  });
  expect(calls[1]!.orderNos).toHaveLength(2); // Four first/latest references share two order numbers.
  const seen = calls.length;
  const clerkList = await docs.listSignedAgreements(
    { role: "clerk", merchantUserId: clerk.id, entityId: current.entity.id },
    { limit: 20 },
  );
  expect(clerkList.viewerRole).toBe("clerk");
  expect(clerkList.items.map((item) => item.agreementKey)).toEqual(["user", "privacy"]);
  for (const item of clerkList.items)
    for (const record of [item.firstConsent, item.latestConsent]) {
      expect(Object.keys(record).sort()).toEqual(
        ["consentNo", "consentedAt", "method", "scene", "versionLabel"].sort(),
      );
    }
  expect(
    await docs.countSignedAgreements(
      { merchantUserId: current.user.id, entityId: current.entity.id },
      {},
    ),
  ).toEqual({ all: 4 });
  expect(calls).toHaveLength(seen);
  expect(await snapshotTables(db, tables)).toEqual(before);
}, 30_000);
