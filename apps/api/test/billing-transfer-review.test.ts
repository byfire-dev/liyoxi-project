import { beforeAll, expect, it } from "vitest";
import {
  createIdentityContext,
  createFlow,
  createTenant,
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
import {
  PaymentOrderAdminDetailSchema,
  TransferProofConfirmResultSchema,
  TransferProofDetailSchema,
} from "@liyoxi/contract";
import type { AdminPaymentOrderCreateBody } from "@liyoxi/contract";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  creator: Awaited<ReturnType<typeof signInAsStaff>>,
  first: Awaited<ReturnType<typeof signInAsStaff>>,
  second: Awaited<ReturnType<typeof signInAsStaff>>,
  peer = 0;
const identity = (id: string) =>
  createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
const routeIds = [
  "admin.paymentOrder.create",
  "admin.paymentOrder.transferProof.create",
  "admin.transferProof.approveReview",
  "admin.transferProof.rejectReview",
] as const;
type Route = (typeof routeIds)[number];
async function request(
  operationId: Route,
  json: unknown,
  headers: Record<string, string>,
  id?: string,
  key: string | null = uuidv7(),
) {
  const route = api.api.mounted.find((r) => r.operationId === operationId);
  expect(route).toBeDefined();
  expect(route!.method).toBe("POST");
  return api.request(
    route!.path.replace("{paymentOrderId}", id ?? "").replace("{transferProofId}", id ?? ""),
    {
      method: "POST",
      json,
      headers: { ...headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
      peer: `198.19.84.${++peer % 250}`,
    },
  );
}
async function data(response: Response): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  creator = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  first = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  second = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const keyring = security.loadKeyring(api.runtime.env);
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring,
    },
    { proposerId: first.staff.id, approverId: second.staff.id },
  );
  const proposal = await api.runtime.tx.run(async (tx) =>
    proposeFinanceConfig(
      tx,
      { approval: api.runtime.approval, clock: api.clock, keyring },
      identity(first.staff.id),
      {
        configKey: "controls",
        payload: { ...DEFAULT_CONTROLS, adminCreateOrder: true, receiptSecondReviewFen: 1 },
        changeNote: "本轮HTTP真实双人控制",
      },
      await sampleStaffContext(db, first.staff.id, { stepUpAt: api.clock.now() }),
    ),
  );
  await api.runtime.tx.run(async (tx) =>
    api.runtime.approval.approve(tx, identity(second.staff.id), {
      approvalId: proposal.approvalId,
      lockVersion: 0,
      staff: await sampleStaffContext(db, second.staff.id, { stepUpAt: api.clock.now() }),
    }),
  );
}, 90_000);
async function input() {
  const own = await make.merchant({ verified: true }),
    plan = await db.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const tenant = createTenant({
    tx: api.runtime.tx,
    clock: api.clock,
    assembly: api.runtime.assembly,
    flow: createFlow({
      assembly: api.runtime.assembly,
      clock: api.clock,
      events: api.runtime.events,
    }),
  });
  const membership = await api.runtime.tx.run((tx) =>
    tenant.resolveMembership(tx, { merchantUserId: own.user.id, storeId: own.store.id }),
  );
  if (!membership) throw new Error("本轮真实老板关系缺失");
  // 本接口只使用正式目录价与首次优惠；报价来自真实billing公口，未造付清事实。
  const quote = await api.runtime.billing.quotePlanPurchase(
    {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: own.user.id, client: "weapp", role: "owner" },
        entityId: own.entity.id,
        storeId: own.store.id,
      }),
      membership,
    },
    { platform: "android" },
    { planId: plan.id, months: 1 },
  );
  const body: AdminPaymentOrderCreateBody = {
    entityId: own.entity.id,
    storeId: own.store.id,
    kind: "plan",
    planId: plan.id,
    months: 1,
    expectAmountFen: quote.payFen,
    contractNo: `HTTP-${uuidv7()}`,
    confirm: { entityName: own.entity.name!, amountFen: quote.payFen },
  };
  return { own, body };
}
async function receipt(entityId: string) {
  // 已完成文件是本四口的输入前置；上传协议继续由原媒体测试覆盖。
  return make.fileObject({
    category: "pay_receipt",
    bucket: "secure",
    scopeType: "entity",
    entityId,
    storeId: null,
    uploadActorType: "staff",
    uploadActorId: first.staff.id,
    uploadClient: "admin",
    mime: "image/png",
    declaredMime: "image/png",
    ext: "png",
  });
}
const tables = [
  "billing_order",
  "transfer_proof",
  "payment_txn",
  "point_ledger_entry",
  "subscription_term",
  "approval_request",
  "audit_log",
  "outbox_event",
  "timer",
  "idempotency_record",
];

it("四正式HTTP挂载完整代建/凭证/退回/新轮批准链，同键复放唯一审计与唯一到账", async () => {
  expect(
    api.api.mounted
      .filter((r) => routeIds.some((id) => id === r.operationId))
      .map((r) => r.operationId)
      .sort(),
  ).toEqual([...routeIds].sort());
  const target = await input(),
    key = uuidv7();
  const order = PaymentOrderAdminDetailSchema.parse(
    await data(
      await request("admin.paymentOrder.create", target.body, creator.headers, undefined, key),
    ),
  );
  const created = await snapshotTables(db, tables);
  expect(
    PaymentOrderAdminDetailSchema.parse(
      await data(
        await request("admin.paymentOrder.create", target.body, creator.headers, undefined, key),
      ),
    ).paymentOrderId,
  ).toBe(order.paymentOrderId);
  expect(await snapshotTables(db, tables)).toEqual(created);
  const file = await receipt(target.own.entity.id);
  const proof = TransferProofDetailSchema.parse(
    await data(
      await request(
        "admin.paymentOrder.transferProof.create",
        { fileId: file.id, note: "HTTP虚构凭证" },
        first.headers,
        order.paymentOrderId,
      ),
    ),
  );
  const confirmation = {
    lockVersion: proof.lockVersion,
    bankSerialNo: `HTTP-${uuidv7()}`,
    confirmChecks: ["bank_statement_checked"],
    confirm: { orderNo: order.orderNo, receivedAmountFen: order.amountFen },
  };
  const confirm = async (version: number) =>
    TransferProofConfirmResultSchema.parse(
      await data(
        await api.request(`/api/v1/admin/transfer-proofs/${proof.transferProofId}/confirm`, {
          method: "POST",
          json: { ...confirmation, lockVersion: version },
          headers: { ...first.headers, "Idempotency-Key": uuidv7() },
          peer: `198.19.84.${++peer % 250}`,
        }),
      ),
    );
  const pending = await confirm(proof.lockVersion);
  expect(pending.outcome).toBe("review_pending");
  expect(await db.paymentTxn.count({ where: { billingOrderId: order.paymentOrderId } })).toBe(0);
  const rejected = TransferProofDetailSchema.parse(
    await data(
      await request(
        "admin.transferProof.rejectReview",
        { approvalId: pending.review!.approvalId, note: "重新核对流水" },
        second.headers,
        proof.transferProofId,
      ),
    ),
  );
  expect(
    (await db.billingOrder.findUniqueOrThrow({ where: { id: order.paymentOrderId } }))
      .transferState,
  ).toBe("proof_submitted");
  const next = await confirm(rejected.lockVersion),
    approvalId = next.review!.approvalId;
  expect(approvalId).not.toBe(pending.review!.approvalId);
  const body = {
      approvalId,
      lockVersion: 0,
      confirmChecks: ["bank_statement_checked"],
      confirm: confirmation.confirm,
    },
    approvalKey = uuidv7();
  const paid = TransferProofConfirmResultSchema.parse(
    await data(
      await request(
        "admin.transferProof.approveReview",
        body,
        second.headers,
        proof.transferProofId,
        approvalKey,
      ),
    ),
  );
  expect(paid.outcome).toBe("paid");
  const once = await snapshotTables(db, tables);
  expect(
    TransferProofConfirmResultSchema.parse(
      await data(
        await request(
          "admin.transferProof.approveReview",
          body,
          second.headers,
          proof.transferProofId,
          approvalKey,
        ),
      ),
    ).outcome,
  ).toBe("paid");
  expect(await snapshotTables(db, tables)).toEqual(once);
  expect(
    await db.paymentTxn.count({
      where: {
        billingOrderId: order.paymentOrderId,
        status: "succeeded",
        appliedAt: { not: null },
      },
    }),
  ).toBe(1);
  expect(
    await db.subscriptionTerm.count({ where: { sourceBillingOrderId: order.paymentOrderId } }),
  ).toBe(1);
  expect(
    await db.auditLog.count({
      where: { action: "billing.transfer_proof.approve_review", targetId: proof.transferProofId },
    }),
  ).toBe(1);
  const get = PaymentOrderAdminDetailSchema.parse(
    await data(
      await api.request(`/api/v1/admin/payment-orders/${order.paymentOrderId}`, {
        headers: creator.headers,
      }),
    ),
  );
  expect(get.status).toBe("paid");
});

it("四路由会话/实际权限/再验证/输入/范围守卫零副作用", async () => {
  const target = await input(),
    forbidden = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() });
  const before = await snapshotTables(db, tables);
  await denied(await request("admin.paymentOrder.create", target.body, {}), 401, "AUTH_REQUIRED");
  await denied(
    await request("admin.paymentOrder.create", target.body, forbidden.headers),
    403,
    "PERMISSION_DENIED",
  );
  await denied(
    await request("admin.paymentOrder.create", { ...target.body, contractNo: "" }, creator.headers),
    400,
    "VALIDATION_FAILED",
  );
  await denied(
    await request("admin.paymentOrder.create", target.body, creator.headers, undefined, null),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  await denied(
    await request(
      "admin.paymentOrder.transferProof.create",
      { fileId: uuidv7() },
      first.headers,
      uuidv7(),
    ),
    404,
    "NOT_FOUND",
  );
  await denied(
    await request(
      "admin.transferProof.approveReview",
      {
        lockVersion: 0,
        confirmChecks: ["bank_statement_checked"],
        confirm: { orderNo: "missing", receivedAmountFen: 1 },
      },
      second.headers,
      uuidv7(),
    ),
    400,
    "VALIDATION_FAILED",
  );
  await denied(
    await request(
      "admin.transferProof.rejectReview",
      { approvalId: uuidv7(), note: "不存在凭证" },
      second.headers,
      uuidv7(),
    ),
    404,
    "NOT_FOUND",
  );
  // 真实注入时钟越过原10分钟再验证窗口，登录会话本身仍有效；不改生产TTL或库约束。
  const at = api.clock.now();
  api.clock.advance(600_001);
  try {
    await denied(
      await request("admin.paymentOrder.create", target.body, creator.headers),
      403,
      "STEP_UP_REQUIRED",
    );
  } finally {
    api.clock.set(at);
  }
  expect(await snapshotTables(db, tables)).toEqual(before);
});
