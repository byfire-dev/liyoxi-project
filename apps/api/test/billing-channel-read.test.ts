// W4-02：六GET穿真实鉴权/管线/服务/DB；paid仅由正式对公凭证确认产生。
import { beforeAll, describe, expect, it } from "vitest";
import {
  createIdentityContext,
  createNotices,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import {
  PaymentOrderListSchema,
  PaymentOrderSummarySchema,
  AdminPaymentOrderPageSchema,
  AdminPaymentOrderSummarySchema,
  PaymentTransactionPageSchema,
  PaymentTransactionSummarySchema,
} from "@liyoxi/contract";
import type { PaymentOrderDetail, PlanQuote } from "@liyoxi/contract";
import type { operations as MerchantOperations } from "@liyoxi/contract/types/merchant";
import type { operations as AdminOperations } from "@liyoxi/contract/types/admin";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi, db: Awaited<ReturnType<typeof h.db.prisma>>, finance: SignedInStaff;
let manager: SignedInStaff, editor: SignedInStaff, clerk: SignedInMerchant;
let versions: string[],
  first: Buyer,
  other: Buyer,
  cancelled: PaymentOrderDetail,
  paid: PaymentOrderDetail;
type Buyer = { owner: SignedInMerchant; entityId: string; storeId: string };
type ReadOperation = Extract<
  keyof MerchantOperations | keyof AdminOperations,
  | "m.paymentOrder.list"
  | "m.paymentOrder.summary"
  | "admin.paymentOrder.list"
  | "admin.paymentOrder.summary"
  | "admin.paymentTransaction.list"
  | "admin.paymentTransaction.summary"
>;
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
  });
async function read(operationId: ReadOperation, path: string, headers: Record<string, string>) {
  const route = api.api.mounted.find((entry) => entry.operationId === operationId);
  expect(route).toBeDefined();
  expect(route!.method).toBe("GET");
  expect(route!.path).toBe(`/api/v1${path.split("?")[0]}`);
  return api.request(`/api/v1${path}`, { headers });
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
async function buyer(): Promise<Buyer> {
  const owner = await signInAsMerchant(api);
  const scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  // 仅资质夹具沿既有billing HTTP测试；付款/交易状态不直接写库。
  await db.entity.update({
    where: { id: scope.entityId },
    data: { verificationStatus: "pending" },
  });
  return { owner, ...scope };
}
async function order(b: Buyer, months: number) {
  const plans = await data<{ items: { planId: string }[] }>(
    await api.request("/api/v1/m/plans", { headers: b.owner.withStore(b.storeId) }),
  );
  const quote = await data<PlanQuote>(
    await post(
      "/m/plans/quote",
      { planId: plans.items[0]!.planId, months },
      b.owner.withStore(b.storeId),
    ),
  );
  return data<PaymentOrderDetail>(
    await post(
      "/m/payment-orders",
      {
        planId: quote.planId,
        months,
        channel: "bank_transfer",
        expectAmountFen: quote.payFen,
        agreementVersionIds: versions,
      },
      b.owner.withStore(b.storeId),
    ),
  );
}
async function pay(b: Buyer, order: PaymentOrderDetail) {
  const files = await data<{ items: { fileId: string; key: string }[] }>(
    await post(
      "/m/files",
      {
        category: "pay_receipt",
        files: [{ fileName: "receipt.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      b.owner.withStore(b.storeId),
    ),
  );
  const file = files.items[0]!;
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
        bankSerialNo: `READ-${uuidv7()}`,
        confirmChecks: ["bank_statement_checked"],
        confirm: { orderNo: order.orderNo, receivedAmountFen: order.amountFen },
      },
      finance.headers,
    ),
  );
  return data<PaymentOrderDetail>(
    await api.request(`/api/v1/m/payment-orders/${order.paymentOrderId}`, {
      headers: b.owner.withStore(b.storeId),
    }),
  );
}
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const make = createFactories({ db, clock: api.clock });
  const staff = await make.staff({ staffRoleKey: "super_admin" }),
    file = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" });
  const notices = createNotices({ clock: api.clock, events: api.runtime.events });
  versions = [];
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7(),
      notice = await api.runtime.tx.run((tx) =>
        notices.announce(
          tx,
          createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
          {
            kind: "agreement_version",
            refId: id,
            title: "读取测试协议",
            summary: "读取测试协议",
            effectiveAt: api.clock.now(),
            shortNoticeReason: "本轮定向测试",
            link: { route: "agreement.version", params: { agreementVersionId: id } },
            createdByStaffId: staff.id,
          },
        ),
      );
    versions.push(
      (
        await make.agreementVersion({
          id,
          agreementKey,
          createdByStaffId: staff.id,
          pdfFileId: file.id,
          siteNoticeId: notice.siteNoticeId,
        })
      ).id,
    );
  }
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
  first = await buyer();
  other = await buyer();
  const initial = await order(first, 1),
    cancelKey = uuidv7();
  const cancelledResult = await data<{ outcome: string; paymentOrder: PaymentOrderDetail }>(
    await post(
      `/m/payment-orders/${initial.paymentOrderId}/cancel`,
      {},
      first.owner.withStore(first.storeId),
      cancelKey,
    ),
  );
  expect(cancelledResult.outcome).toBe("cancelled");
  expect(cancelledResult.paymentOrder.bankAccount?.accountNo).toBe("0000000000000000");
  const transitions = await db.statusTransition.count({
    where: { machine: "billing_order", subjectId: initial.paymentOrderId },
  });
  const replayResponse = await post(
    `/m/payment-orders/${initial.paymentOrderId}/cancel`,
    {},
    first.owner.withStore(first.storeId),
    cancelKey,
  );
  expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await data(replayResponse)).toMatchObject({
    outcome: "cancelled",
    paymentOrder: { bankAccount: { accountNo: null } },
  });
  expect(
    await db.statusTransition.count({
      where: { machine: "billing_order", subjectId: initial.paymentOrderId },
    }),
  ).toBe(transitions);
  cancelled = cancelledResult.paymentOrder;
  paid = await pay(first, await order(first, 3));
  await order(other, 1);
  expect(paid).toMatchObject({ status: "paid", fulfillmentStatus: "done" });
  manager = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() });
  editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  // 负责人关系是授权夹具，不伪造付款事实。
  await db.store.update({
    where: { id: first.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({
    entityId: first.entityId,
    merchantUserId: clerk.merchantUserId,
  });
  await make.storeMember({
    entityId: first.entityId,
    entityMemberId: member.id,
    storeId: first.storeId,
  });
}, 90_000);

describe("付款查询真实HTTP", { timeout: 30_000 }, () => {
  it("m.paymentOrder.list / m.paymentOrder.summary：真实paid、游标同刻断点、开票口径、跨主体与店员拒绝", async () => {
    const headers = first.owner.withStore(first.storeId);
    const page1 = PaymentOrderListSchema.parse(
      await data(await read("m.paymentOrder.list", "/m/payment-orders?limit=1", headers)),
    );
    expect(page1).toMatchObject({ hasMore: true, items: [expect.any(Object)] });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = PaymentOrderListSchema.parse(
      await data(
        await read(
          "m.paymentOrder.list",
          `/m/payment-orders?limit=1&cursor=${page1.nextCursor}`,
          headers,
        ),
      ),
    );
    expect(page2).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...page1.items, ...page2.items].map((row) => row.paymentOrderId))).toEqual(
      new Set([cancelled.paymentOrderId, paid.paymentOrderId]),
    );
    expect(
      [...page1.items, ...page2.items].find((row) => row.paymentOrderId === paid.paymentOrderId),
    ).toMatchObject({
      status: "paid",
      invoiceState: "eligible",
      invoiceItemName: null,
      actions: [],
    });
    const eligible = PaymentOrderListSchema.parse(
      await data(
        await read(
          "m.paymentOrder.list",
          "/m/payment-orders?invoiceState=eligible,applying",
          headers,
        ),
      ),
    );
    expect(eligible.items.map((row) => row.paymentOrderId)).toEqual([paid.paymentOrderId]);
    expect(
      PaymentOrderSummarySchema.parse(
        await data(
          await read(
            "m.paymentOrder.summary",
            "/m/payment-orders/summary?invoiceState=eligible",
            headers,
          ),
        ),
      ),
    ).toEqual({ total: 1 });
    expect(
      PaymentOrderSummarySchema.parse(
        await data(
          await read(
            "m.paymentOrder.summary",
            "/m/payment-orders/summary?status=cancelled&invoiceState=not_eligible",
            headers,
          ),
        ),
      ),
    ).toEqual({ total: 1 });
    expect(
      PaymentOrderListSchema.parse(
        await data(
          await read("m.paymentOrder.list", "/m/payment-orders?cursor=broken&limit=1", headers),
        ),
      ),
    ).toEqual(page1);
    expect(
      PaymentOrderSummarySchema.parse(
        await data(
          await read(
            "m.paymentOrder.summary",
            `/m/payment-orders/summary?no=${paid.orderNo}`,
            other.owner.withStore(other.storeId),
          ),
        ),
      ),
    ).toEqual({ total: 0 });
    await denied(
      await read("m.paymentOrder.list", "/m/payment-orders", clerk.withStore(first.storeId)),
      403,
      "ROLE_FORBIDDEN",
    );
    await denied(
      await read(
        "m.paymentOrder.summary",
        "/m/payment-orders/summary",
        clerk.withStore(first.storeId),
      ),
      403,
      "ROLE_FORBIDDEN",
    );
  });

  it("admin.paymentOrder.list / summary、admin.paymentTransaction.list / summary：范围、分页、false筛选与固定KPI不随过滤变化", async () => {
    const before = {
      orders: await db.billingOrder.findMany(),
      transactions: await db.paymentTxn.findMany(),
      ledger: await db.ledgerOperation.count(),
      idem: await db.idempotencyRecord.count(),
    };
    const orders = AdminPaymentOrderPageSchema.parse(
      await data(
        await read(
          "admin.paymentOrder.list",
          "/admin/payment-orders?pageSize=1&sort=-amountFen",
          manager.headers,
        ),
      ),
    );
    expect(orders).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(orders.items[0]).toMatchObject({
      paymentOrderId: paid.paymentOrderId,
      entity: { entityId: first.entityId },
      status: "paid",
    });
    const second = AdminPaymentOrderPageSchema.parse(
      await data(
        await read(
          "admin.paymentOrder.list",
          "/admin/payment-orders?page=2&pageSize=1&sort=-amountFen",
          manager.headers,
        ),
      ),
    );
    expect(second.items[0]?.paymentOrderId).toBe(cancelled.paymentOrderId);
    const summary = AdminPaymentOrderSummarySchema.parse(
      await data(
        await read("admin.paymentOrder.summary", "/admin/payment-orders/summary", manager.headers),
      ),
    );
    expect(summary).toEqual({
      all: 2,
      pending_payment: 0,
      pending_confirmation: 0,
      paid: 1,
      cancelled: 1,
      refunded: 0,
    });
    expect(
      AdminPaymentOrderPageSchema.parse(
        await data(
          await read(
            "admin.paymentOrder.list",
            `/admin/payment-orders?entityId=${other.entityId}`,
            manager.headers,
          ),
        ),
      ).total,
    ).toBe(0);
    expect(
      AdminPaymentOrderSummarySchema.parse(
        await data(
          await read(
            "admin.paymentOrder.summary",
            `/admin/payment-orders/summary?entityId=${other.entityId}`,
            manager.headers,
          ),
        ),
      ).all,
    ).toBe(0);
    const query = `channel=bank_transfer&isApplied=true&q=${paid.orderNo}`;
    const txns = PaymentTransactionPageSchema.parse(
      await data(
        await read(
          "admin.paymentTransaction.list",
          `/admin/payment-transactions?${query}`,
          finance.headers,
        ),
      ),
    );
    expect(txns).toMatchObject({
      total: 1,
      items: [
        {
          paymentOrder: { paymentOrderId: paid.paymentOrderId },
          channelAmountFen: paid.amountFen,
          isApplied: true,
        },
      ],
    });
    const totals = PaymentTransactionSummarySchema.parse(
      await data(
        await read(
          "admin.paymentTransaction.summary",
          `/admin/payment-transactions/summary?${query}`,
          finance.headers,
        ),
      ),
    );
    expect(totals.filtered).toEqual({ count: 1, channelAmountFen: String(paid.amountFen) });
    expect(totals.today).toEqual({
      amountFen: String(paid.amountFen),
      count: 1,
      wechatCount: 0,
      bankCount: 1,
    });
    const empty = PaymentTransactionSummarySchema.parse(
      await data(
        await read(
          "admin.paymentTransaction.summary",
          "/admin/payment-transactions/summary?isApplied=false",
          finance.headers,
        ),
      ),
    );
    expect(empty.filtered).toEqual({ count: 0, channelAmountFen: "0" });
    expect(empty.today).toEqual(totals.today);
    expect(empty.month).toEqual(totals.month);
    expect(empty.monthRefund).toEqual({ amountFen: "0", count: 0 });
    expect(empty.openDiff).toEqual({ amountFen: "0", count: 0, earliestBillDate: null });
    expect(
      PaymentTransactionPageSchema.parse(
        await data(
          await read(
            "admin.paymentTransaction.list",
            "/admin/payment-transactions?isApplied=false",
            finance.headers,
          ),
        ),
      ).total,
    ).toBe(0);
    for (const [operation, path] of [
      ["admin.paymentOrder.list", "/admin/payment-orders"],
      ["admin.paymentOrder.summary", "/admin/payment-orders/summary"],
      ["admin.paymentTransaction.list", "/admin/payment-transactions"],
      ["admin.paymentTransaction.summary", "/admin/payment-transactions/summary"],
    ] as const) {
      await denied(await read(operation, path, editor.headers), 403, "PERMISSION_DENIED");
    }
    expect({
      orders: await db.billingOrder.findMany(),
      transactions: await db.paymentTxn.findMany(),
      ledger: await db.ledgerOperation.count(),
      idem: await db.idempotencyRecord.count(),
    }).toEqual(before);
  });
});
