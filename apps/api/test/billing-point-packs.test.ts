import { beforeAll, expect, it } from "vitest";
import {
  createIdentityContext,
  createNotices,
  proposeFinanceConfig,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import {
  createFactories,
  sampleStaffContext,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import {
  PointPackRowSchema,
  PointPackListSchema,
  PointPackAdminListSchema,
  PointPackSummarySchema,
  PaymentOrderDetailSchema,
} from "@liyoxi/contract";
import type { PaymentOrderDetail, PlanQuote } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";
const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  versions: string[],
  pointsVersion: string,
  admin: Awaited<ReturnType<typeof signInAsStaff>>,
  finance: Awaited<ReturnType<typeof signInAsStaff>>,
  peer = 0;
type Buyer = { owner: SignedInMerchant; entityId: string; storeId: string };
const identity = (id: string) =>
  createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
async function data<T>(r: Response): Promise<T> {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
async function denied(r: Response, status: number, error: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error });
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.86.${++peer % 250}`,
  });
type PackOperation =
  | "m.pointPack.list"
  | "admin.pointPack.list"
  | "admin.pointPack.summary"
  | "admin.pointPack.create"
  | "admin.pointPack.update"
  | "admin.pointPack.shelve"
  | "admin.pointPack.delist";
async function packRequest(
  operationId: PackOperation,
  headers: Record<string, string>,
  json?: unknown,
  id?: string,
  key = uuidv7(),
  query = "",
) {
  const mounted = api.api.mounted.find((row) => row.operationId === operationId);
  expect(mounted).toBeDefined();
  expect(mounted!.method).toBe(
    operationId.endsWith(".update")
      ? "PATCH"
      : operationId.endsWith(".list") || operationId.endsWith(".summary")
        ? "GET"
        : "POST",
  );
  const path = mounted!.path.replace("{pointPackId}", id ?? "") + query;
  return api.request(path, {
    method: mounted!.method,
    ...(json === undefined ? {} : { json }),
    headers: { ...headers, ...(mounted!.method === "GET" ? {} : { "Idempotency-Key": key }) },
    peer: `198.19.86.${++peer % 250}`,
  });
}
async function buyer(): Promise<Buyer> {
  const owner = await signInAsMerchant(api, { headers: { "X-Client-Platform": "android" } });
  const scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  // 与原billing HTTP组相同，只准备本轮资质前置；付款、周期、加购都经正式公口。
  await db.entity.update({
    where: { id: scope.entityId },
    data: { verificationStatus: "pending" },
  });
  return { owner, ...scope };
}
async function activate(b: Buyer) {
  const plans = await data<{ items: { planId: string }[] }>(
    await api.request("/api/v1/m/plans", { headers: b.owner.withStore(b.storeId) }),
  );
  const quote = await data<PlanQuote>(
    await post(
      "/m/plans/quote",
      { planId: plans.items[0]!.planId, months: 1 },
      b.owner.withStore(b.storeId),
    ),
  );
  const order = PaymentOrderDetailSchema.parse(
    await data(
      await post(
        "/m/payment-orders",
        {
          planId: quote.planId,
          months: 1,
          channel: "bank_transfer",
          expectAmountFen: quote.payFen,
          agreementVersionIds: versions,
        },
        b.owner.withStore(b.storeId),
      ),
    ),
  );
  await pay(b, order);
  return order;
}
async function pay(b: Buyer, order: PaymentOrderDetail) {
  const created = await data<{ items: { fileId: string; key: string }[] }>(
    await post(
      "/m/files",
      {
        category: "pay_receipt",
        files: [{ fileName: "receipt.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      b.owner.withStore(b.storeId),
    ),
  );
  const file = created.items[0]!;
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "secure", key: file.key },
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/png",
  );
  await data(await post(`/m/files/${file.fileId}/complete`, {}, b.owner.withStore(b.storeId)));
  const job = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  const proof = await data<PaymentOrderDetail>(
    await post(
      `/m/payment-orders/${order.paymentOrderId}/transfer-proofs`,
      { fileId: file.fileId },
      b.owner.withStore(b.storeId),
    ),
  );
  await data(
    await post(
      `/admin/transfer-proofs/${proof.latestTransferProof!.transferProofId}/confirm`,
      {
        lockVersion: 0,
        bankSerialNo: `PACK-${uuidv7()}`,
        confirmChecks: ["bank_statement_checked"],
        confirm: { orderNo: order.orderNo, receivedAmountFen: order.amountFen },
      },
      finance.headers,
    ),
  );
}
const topup = (
  b: Buyer,
  id: string,
  amount: number,
  key = uuidv7(),
  agreementVersionIds = [pointsVersion],
) =>
  post(
    "/m/payment-orders",
    {
      pointPackId: id,
      channel: "bank_transfer",
      expectAmountFen: amount,
      agreementVersionIds,
    },
    b.owner.withStore(b.storeId),
    key,
  );
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const make = createFactories({ db, clock: api.clock }),
    staff = await make.staff({ staffRoleKey: "super_admin" }),
    doc = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" });
  const notices = createNotices({ clock: api.clock, events: api.runtime.events });
  versions = [];
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7();
    const notice = await api.runtime.tx.run((tx) =>
      notices.announce(tx, identity(staff.id), {
        kind: "agreement_version",
        refId: id,
        title: "积分包测试协议",
        summary: "仅本轮测试",
        effectiveAt: api.clock.now(),
        shortNoticeReason: "定向夹具",
        link: { route: "agreement.version", params: { agreementVersionId: id } },
        createdByStaffId: staff.id,
      }),
    );
    const version = await make.agreementVersion({
      id,
      agreementKey,
      createdByStaffId: staff.id,
      pdfFileId: doc.id,
      siteNoticeId: notice.siteNoticeId,
    });
    versions.push(version.id);
    if (agreementKey === "points") pointsVersion = version.id;
  }
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const approver = await signInAsStaff(db, {
    roleKey: "finance",
    isLead: true,
    now: api.clock.now(),
  });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: finance.staff.id, approverId: approver.staff.id },
  );
  const proposal = await api.runtime.tx.run(async (tx) =>
    proposeFinanceConfig(
      tx,
      {
        approval: api.runtime.approval,
        clock: api.clock,
        keyring: security.loadKeyring(api.runtime.env),
      },
      identity(finance.staff.id),
      {
        configKey: "purchase_policy",
        payload: {
          rules: [{ when: { platforms: ["ios"] }, then: { mode: "hidden" } }],
        },
        changeNote: "本轮iOS策略隐藏验证",
      },
      await sampleStaffContext(db, finance.staff.id, { stepUpAt: api.clock.now() }),
    ),
  );
  await api.runtime.tx.run(async (tx) =>
    api.runtime.approval.approve(tx, identity(approver.staff.id), {
      approvalId: proposal.approvalId,
      lockVersion: 0,
      staff: await sampleStaffContext(db, approver.staff.id, { stepUpAt: api.clock.now() }),
    }),
  );
}, 90000);
it("七资源真实HTTP与冻结价格加购：版本/上下架/报价/协议/C50及一次履约", async () => {
  const created = PointPackRowSchema.parse(
    await data(
      await packRequest("admin.pointPack.create", admin.headers, { points: 617, priceFen: 200001 }),
    ),
  );
  const b = await buyer();
  await denied(
    await topup(b, created.pointPackId, created.priceFen),
    409,
    "TOPUP_REQUIRES_ACTIVE_PLAN",
  );
  const plan = await activate(b);
  expect(
    PointPackListSchema.parse(
      await data(await packRequest("m.pointPack.list", b.owner.withStore(b.storeId))),
    ).items,
  ).toContainEqual({ pointPackId: created.pointPackId, points: 617, priceFen: 200001 });
  const key = uuidv7(),
    order = PaymentOrderDetailSchema.parse(
      await data(await topup(b, created.pointPackId, created.priceFen, key)),
    );
  expect(order).toMatchObject({
    type: "topup",
    amountFen: 200001,
    content: { kind: "topup", points: 617 },
  });
  expect(order.bankAccount?.accountNo).toBe("0000000000000000");
  const before = await snapshotTables(db, [
    "billing_order",
    "agreement_consent",
    "status_transition",
    "audit_log",
    "outbox_event",
  ]);
  const replay = await topup(b, created.pointPackId, created.priceFen, key);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await data(replay)).toMatchObject({
    paymentOrderId: order.paymentOrderId,
    bankAccount: { accountNo: null },
  });
  expect(
    await snapshotTables(db, [
      "billing_order",
      "agreement_consent",
      "status_transition",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(before);
  expect(
    await db.agreementConsent.findMany({
      where: { bizType: "billing_order", bizId: order.paymentOrderId },
    }),
  ).toMatchObject([{ scene: "topup", agreementKey: "points", agreementVersionId: pointsVersion }]);
  await denied(
    await packRequest(
      "admin.pointPack.update",
      admin.headers,
      { lockVersion: 99, priceFen: 300001 },
      created.pointPackId,
    ),
    409,
    "VERSION_CONFLICT",
  );
  await data(
    await packRequest(
      "admin.pointPack.update",
      admin.headers,
      { lockVersion: 0, priceFen: 300001 },
      created.pointPackId,
    ),
  );
  const stale = await topup(b, created.pointPackId, 200001);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "QUOTE_CHANGED",
    details: { kind: "topup", amountFen: 300001 },
  });
  await data(
    await packRequest("admin.pointPack.delist", admin.headers, undefined, created.pointPackId),
  );
  await denied(await topup(b, created.pointPackId, 300001), 409, "PLAN_NOT_AVAILABLE");
  await pay(b, order);
  const final = PaymentOrderDetailSchema.parse(
    await data(
      await api.request(`/api/v1/m/payment-orders/${order.paymentOrderId}`, {
        headers: b.owner.withStore(b.storeId),
      }),
    ),
  );
  expect(final).toMatchObject({ status: "paid", fulfillmentStatus: "done", amountFen: 200001 });
  expect(
    await db.pointLot.findMany({
      where: { sourceType: "purchase", sourceId: order.paymentOrderId },
    }),
  ).toMatchObject([{ originalQty: 617, costBasisFen: 200001, expiresAt: null }]);
  await data(
    await packRequest("admin.pointPack.shelve", admin.headers, undefined, created.pointPackId),
  );
  const readBefore = await snapshotTables(db, [
    "billing_order",
    "point_pack",
    "ledger_operation",
    "point_lot",
    "point_ledger_entry",
    "audit_log",
  ]);
  const list = PointPackAdminListSchema.parse(
    await data(
      await packRequest(
        "admin.pointPack.list",
        admin.headers,
        undefined,
        undefined,
        undefined,
        "?isListed=true",
      ),
    ),
  );
  expect(list.items.find((p) => p.pointPackId === created.pointPackId)).toMatchObject({
    soldThisMonthCount: 1,
    soldThisMonthFen: "200001",
    isListed: true,
  });
  expect(
    PointPackSummarySchema.parse(
      await data(await packRequest("admin.pointPack.summary", admin.headers)),
    ).monthly,
  ).toHaveLength(6);
  expect(
    await snapshotTables(db, [
      "billing_order",
      "point_pack",
      "ledger_operation",
      "point_lot",
      "point_ledger_entry",
      "audit_log",
    ]),
  ).toEqual(readBefore);
  expect(
    await db.billingOrder.findUniqueOrThrow({ where: { id: plan.paymentOrderId } }),
  ).toMatchObject({ status: "paid", fulfillmentStatus: "done" });
}, 30_000);
it("越界输入/店员/跨主体/失资格/退款与策略关闭拒绝，实际付款与账本零写", async () => {
  const make = createFactories({ db, clock: api.clock }),
    b = await buyer(),
    other = await buyer();
  const pack = PointPackRowSchema.parse(
    await data(
      await packRequest("admin.pointPack.create", admin.headers, { points: 733, priceFen: 200001 }),
    ),
  );
  const plan = await activate(b);
  const clerk = await signInAsMerchant(api),
    member = await make.entityMember({
      entityId: b.entityId,
      merchantUserId: clerk.merchantUserId,
    });
  await make.storeMember({ entityId: b.entityId, entityMemberId: member.id, storeId: b.storeId });
  const before = await snapshotTables(db, [
    "point_pack",
    "billing_order",
    "payment_txn",
    "agreement_consent",
    "ledger_operation",
    "point_lot",
    "point_ledger_entry",
    "audit_log",
  ]);
  await denied(
    await packRequest("admin.pointPack.create", admin.headers, {
      points: 100,
      priceFen: 1,
      position: -2147483649,
    }),
    400,
    "VALIDATION_FAILED",
  );
  await denied(
    await packRequest("m.pointPack.list", clerk.withStore(b.storeId)),
    403,
    "ROLE_FORBIDDEN",
  );
  await denied(
    await post(
      "/m/payment-orders",
      {
        pointPackId: pack.pointPackId,
        channel: "bank_transfer",
        expectAmountFen: pack.priceFen,
        agreementVersionIds: [pointsVersion],
      },
      other.owner.withStore(b.storeId),
    ),
    403,
    "NOT_A_MEMBER",
  );
  await denied(
    await topup(b, pack.pointPackId, pack.priceFen, uuidv7(), [versions[0]!]),
    409,
    "AGREEMENT_VERSION_STALE",
  );
  expect(
    await snapshotTables(db, [
      "point_pack",
      "billing_order",
      "payment_txn",
      "agreement_consent",
      "ledger_operation",
      "point_lot",
      "point_ledger_entry",
      "audit_log",
    ]),
  ).toEqual(before);
  await db.entity.update({
    where: { id: b.entityId },
    data: { verificationStatus: "unsubmitted" },
  });
  const unqualified = await snapshotTables(db, [
    "billing_order",
    "ledger_operation",
    "point_lot",
    "agreement_consent",
  ]);
  await denied(
    await topup(b, pack.pointPackId, pack.priceFen),
    409,
    "PURCHASE_QUALIFICATION_REQUIRED",
  );
  expect(
    await snapshotTables(db, [
      "billing_order",
      "ledger_operation",
      "point_lot",
      "agreement_consent",
    ]),
  ).toEqual(unqualified);
  await db.entity.update({ where: { id: b.entityId }, data: { verificationStatus: "pending" } });
  const hiddenBefore = await snapshotTables(db, [
    "billing_order",
    "payment_txn",
    "ledger_operation",
    "point_lot",
    "agreement_consent",
  ]);
  await denied(
    await post(
      "/m/payment-orders",
      {
        pointPackId: pack.pointPackId,
        channel: "bank_transfer",
        expectAmountFen: pack.priceFen,
        agreementVersionIds: [pointsVersion],
      },
      { ...b.owner.withStore(b.storeId), "X-Client-Platform": "ios" },
    ),
    403,
    "PURCHASE_NOT_OFFERED",
  );
  expect(
    await snapshotTables(db, [
      "billing_order",
      "payment_txn",
      "ledger_operation",
      "point_lot",
      "agreement_consent",
    ]),
  ).toEqual(hiddenBefore);
  const paid = await db.billingOrder.findUniqueOrThrow({ where: { id: plan.paymentOrderId } }),
    approvalId = uuidv7(),
    now = api.clock.now();
  await db.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK${approvalId.replaceAll("-", "")}`,
      kind: "plan_refund",
      category: "approval",
      subjectType: "billing_order",
      subjectId: paid.id,
      entityId: b.entityId,
      status: "pending",
      summarySnapshot: { title: "本轮退款闸门" },
      requesterStaffId: admin.staff.id,
      submitActorType: "system",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const refund = await db.refundRequest.create({
    data: {
      id: uuidv7(),
      approvalRequestId: approvalId,
      source: "customer_service",
      entityId: b.entityId,
      billingOrderId: paid.id,
      paymentTxnId: paid.paidPaymentTxnId!,
      baseAmountFen: paid.amountFen,
      amountFen: paid.amountFen,
      breakdownSnapshot: {},
      ruleCode: "window",
      ruleText: "本轮退款闸门",
      reasonCode: "other",
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  const term = await db.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: paid.id },
  });
  await db.subscriptionTerm.update({
    where: { id: term.id },
    data: { refundRequestId: refund.id, refundRule: "window" },
  });
  const frozen = await snapshotTables(db, [
    "billing_order",
    "payment_txn",
    "ledger_operation",
    "point_lot",
    "agreement_consent",
  ]);
  await denied(await topup(b, pack.pointPackId, pack.priceFen), 409, "PLAN_REFUND_IN_PROGRESS");
  expect(
    await snapshotTables(db, [
      "billing_order",
      "payment_txn",
      "ledger_operation",
      "point_lot",
      "agreement_consent",
    ]),
  ).toEqual(frozen);
  // 本轮正式提议/双人审批的iOS隐藏规则；列表与创建消费同一实际配置。
  expect(
    PointPackListSchema.parse(
      await data(
        await packRequest("m.pointPack.list", {
          ...b.owner.withStore(b.storeId),
          "X-Client-Platform": "ios",
        }),
      ),
    ).items,
  ).toEqual([]);
}, 30_000);
