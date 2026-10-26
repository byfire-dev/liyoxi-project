import { beforeAll, expect, it } from "vitest";
import { PlanAdminQuoteSchema, PlanQuoteSchema, StaffMeSchema } from "@liyoxi/contract";
import type { PlanQuote } from "@liyoxi/contract";
import {
  createIdentityContext,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import {
  applyReceipt,
  createFactories,
  createPaymentHarness,
  pendingPlanOrder,
  signInAsStaff,
  snapshotTables,
  transferReceipt,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";
const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  admin: SignedInStaff,
  peer = 0;
const tables = [
  "plan",
  "plan_revision",
  "billing_param",
  "billing_account",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "billing_order",
  "payment_txn",
  "plan_promo_claim",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  const proposer = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() }),
    reviewer = await createFactories({ db, clock: api.clock }).staff({
      staffRoleKey: "finance",
      isLead: true,
    });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: proposer.staff.id, approverId: reviewer.id },
  );
}, 120000);
const post = (body: unknown, staff = admin) =>
  api.request("/api/v1/admin/plans/quote", {
    method: "POST",
    json: body,
    headers: staff.headers,
    peer: `198.19.73.${++peer % 250}`,
  });
async function quote(body: unknown, staff = admin) {
  const response = await post(body, staff);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  return PlanAdminQuoteSchema.parse(((await response.json()) as { data: unknown }).data);
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
async function buyer() {
  const owner = await signInAsMerchant(api, { headers: { "X-Client-Platform": "android" } }),
    scope = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    ),
    payment = createPaymentHarness(db, { clock: api.clock }),
    order = await pendingPlanOrder(payment, { entityId: scope.entityId }),
    receipt = await transferReceipt(payment, order);
  expect((await applyReceipt(payment, receipt)).result).toMatchObject({ status: "applied" });
  const term = await db.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: order.id },
  });
  return { ...scope, owner, term, order, receipt };
}

it("正式typed报价无幂等写；billing/order任一查看放行、双无权拒绝、主体范围统一404", async () => {
  const pro = await db.plan.findUniqueOrThrow({ where: { code: "pro" } }),
    body = { kind: "renewal", planId: pro.id, months: 1 },
    who = await buyer();
  // 只改本隔离库的两个角色输入，实测两个独立授权分支；不改生产角色默认值。
  for (const [key, none] of [
    ["finance", "order"],
    ["delivery_manager", "billing"],
  ] as const) {
    const role = await db.staffRole.findUniqueOrThrow({ where: { key } });
    await db.staffRole.update({
      where: { key },
      data: {
        moduleLevels: { ...(role.moduleLevels as Record<string, string>), [none]: "n" },
      },
    });
  }
  const finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() }),
    manager = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() }),
    editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() }),
    before = await snapshotTables(db, tables);
  for (const [session, expected] of [
    [finance, { billing: "v", order: "n" }],
    [manager, { billing: "n", order: "v" }],
  ] as const) {
    const response = await api.request("/api/v1/admin/auth/me", { headers: session.headers });
    expect(response.status, await response.clone().text()).toBe(200);
    const me = StaffMeSchema.parse(((await response.json()) as { data: unknown }).data);
    expect(me.moduleLevels).toMatchObject(expected);
  }
  expect((await quote(body, finance)).scope).toBe("generic");
  expect((await quote(body, manager)).scope).toBe("generic");
  await denied(await post(body, editor), 403, "PERMISSION_DENIED");
  await denied(
    await api.request("/api/v1/admin/plans/quote", { method: "POST", json: body }),
    401,
    "AUTH_REQUIRED",
  );
  for (const invalid of [
    { kind: "renewal", planId: pro.id },
    { kind: "upgrade", planId: pro.id },
    { ...body, months: 0 },
    { ...body, kind: "other" },
    { ...body, unknown: true },
  ])
    await denied(await post(invalid), 400, "VALIDATION_FAILED");
  for (const id of [who.entityId, uuidv7()])
    await denied(await post({ ...body, pointAccountId: id }, manager), 404, "NOT_FOUND");
  expect(await snapshotTables(db, tables)).toEqual(before);
  await db.store.update({
    where: { id: who.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
  const assigned = await snapshotTables(db, tables);
  expect((await quote({ ...body, pointAccountId: who.entityId }, manager)).scope).toBe("entity");
  expect(await snapshotTables(db, tables)).toEqual(assigned);
}, 60000);

it("主体试算复用商家真实升级/续费报价；renewal缺省下期、显式intent有效，退款闸门零写", async () => {
  const who = await buyer(),
    flagship = await db.plan.findUniqueOrThrow({ where: { code: "flagship" } }),
    base = { planId: flagship.id, months: 3 },
    merchant = async (intent: "upgrade_now" | "renew_next_term") => {
      const response = await api.request("/api/v1/m/plans/quote", {
        method: "POST",
        json: { ...base, intent },
        headers: who.owner.withStore(who.storeId),
        peer: `198.19.73.${++peer % 250}`,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return PlanQuoteSchema.parse(((await response.json()) as { data: unknown }).data);
    },
    before = await snapshotTables(db, tables);
  const withoutPolicy = ({ policy: _policy, ...rest }: PlanQuote) => rest;
  for (const [kind, intent] of [
    ["upgrade", "upgrade_now"],
    ["renewal", "renew_next_term"],
  ] as const) {
    const result = await quote({ ...base, kind, pointAccountId: who.entityId });
    expect(result.scope).toBe("entity");
    if (result.scope !== "entity") throw new Error("主体报价被降成通用报价");
    expect(result.generic).toBeNull();
    expect(withoutPolicy(result.quote)).toEqual(withoutPolicy(await merchant(intent)));
    expect(result.quote).toMatchObject({
      action: kind === "upgrade" ? "upgrade" : "renew_upgrade",
      effectiveMode: kind === "upgrade" ? "immediate" : "next_term",
      policy: { mode: "in_app", isPriceShown: true, isPurchasePromptAllowed: false, channels: [] },
    });
  }
  const explicit = await quote({
    ...base,
    kind: "renewal",
    intent: "upgrade_now",
    pointAccountId: who.entityId,
  });
  if (explicit.scope !== "entity") throw new Error("缺主体报价");
  expect(explicit.quote.action).toBe("upgrade");
  expect(await snapshotTables(db, tables)).toEqual(before);
  // 合法的既有待退款事实输入；本包不冒称实现退款发起流程。
  const now = api.clock.now(),
    approvalId = uuidv7(),
    refundId = uuidv7(),
    requestNo = await api.runtime.tx.run((tx) => api.runtime.bizNo.next(tx, "TK"));
  await db.approvalRequest.create({
    data: {
      id: approvalId,
      kind: "plan_refund",
      requestNo,
      category: "approval",
      subjectType: "billing_order",
      subjectId: who.order.id,
      entityId: who.entityId,
      status: "pending",
      summarySnapshot: { title: "报价退款闸门夹具" },
      requesterStaffId: admin.staff.id,
      submitActorType: "system",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.refundRequest.create({
    data: {
      id: refundId,
      approvalRequestId: approvalId,
      source: "customer_service",
      entityId: who.entityId,
      billingOrderId: who.order.id,
      paymentTxnId: who.receipt.id,
      baseAmountFen: who.order.amountFen,
      amountFen: who.order.amountFen,
      breakdownSnapshot: {},
      ruleCode: "window",
      ruleText: "报价退款闸门夹具",
      reasonCode: "other",
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.subscriptionTerm.update({
    where: { id: who.term.id },
    data: {
      refundRequestId: refundId,
      refundRule: "window",
    },
  });
  const suspended = await snapshotTables(db, [...tables, "refund_request", "approval_request"]);
  await denied(
    await post({ ...base, kind: "renewal", pointAccountId: who.entityId }),
    409,
    "PLAN_REFUND_IN_PROGRESS",
  );
  expect(await snapshotTables(db, [...tables, "refund_request", "approval_request"])).toEqual(
    suspended,
  );
}, 60000);
