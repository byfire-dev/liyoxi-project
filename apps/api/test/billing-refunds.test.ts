import { beforeAll, expect, it } from "vitest";
import {
  CashRefundQuoteSchema,
  RefundRequestDetailSchema,
  RefundRequestPageSchema,
  RefundSummarySchema,
} from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  createPaymentHarness,
  pendingPlanOrder,
  pendingWechatReceipt,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { FakeWechatPay, SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  creator: SignedInStaff,
  approver: SignedInStaff,
  executor: SignedInStaff,
  provider: FakeWechatPay;
let peer = 1;
const operations = [
  "admin.paymentOrder.refundQuote",
  "admin.paymentOrder.refundRequest.create",
  "admin.refundRequest.approve",
  "admin.refundRequest.confirmNotAccepted",
  "admin.refundRequest.execute",
  "admin.refundRequest.get",
  "admin.refundRequest.list",
  "admin.refundRequest.recordOffline",
  "admin.refundRequest.reject",
  "admin.refundRequest.retry",
  "admin.refundRequest.summary",
  "admin.refundRequest.void",
  "admin.refundRequest.withdraw",
  "hooks.wechatpay.refund.notify",
] as const;
type Operation = (typeof operations)[number];
function request(
  op: Operation,
  staff: SignedInStaff,
  options: { id?: string; body?: unknown; key?: string | null; query?: string } = {},
) {
  const route = api.api.mounted.find((r) => r.operationId === op);
  expect(route).toBeDefined();
  return api.request(
    route!.path.replace(/\{[^}]+\}/g, options.id ?? "") +
      (options.query ? `?${options.query}` : ""),
    {
      method: route!.method,
      headers: {
        ...staff.headers,
        ...(route!.method !== "GET" && options.key !== null
          ? { "Idempotency-Key": options.key ?? uuidv7() }
          : {}),
      },
      ...(options.body === undefined ? {} : { json: options.body }),
      peer: `198.19.88.${++peer % 250}`,
    },
  );
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
beforeAll(async () => {
  api = await handle.start({ wechatPay: { appid: "wx0000000000000000", mchid: "1900000109" } });
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  await db.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "refund_reason",
      code: "RFTEST",
      name: "隔离退款验证",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  creator = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  approver = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  executor = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  provider = api.runtime.providers.wechatPay as FakeWechatPay;
  provider.useWireFormat({ appid: "wx0000000000000000", mchid: "1900000109" });
}, 60_000);
async function paid() {
  const h = createPaymentHarness(db, { clock: api.clock }),
    own = await make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" }),
    receipt = await pendingWechatReceipt(h, order);
  await provider.createJsapiOrder({
    outTradeNo: receipt.outTradeNo,
    description: "退款HTTP真实链前置",
    amountFen: receipt.amountFen,
    payerOpenid: receipt.payerOpenid!,
    attach: receipt.attach!,
    expireAt: order.expiresAt,
  });
  const notification = provider.pay(receipt.outTradeNo),
    wire = provider.encode(notification);
  const response = await api.request("/api/v1/hooks/wechatpay/transactions", {
    method: "POST",
    headers: wire.headers,
    body: wire.rawBody,
    peer: `198.19.89.${++peer % 250}`,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = await db.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
  expect(saved).toMatchObject({ status: "paid", fulfillmentStatus: "done" });
  return {
    ...own,
    order: saved,
    receipt: await db.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } }),
  };
}
async function created() {
  const own = await paid(),
    reason = await db.dictItem.findFirstOrThrow({
      where: { dictTypeKey: "refund_reason", isEnabled: true },
    }),
    body = {
      ruleCode: "window",
      reasonCode: reason.code,
      note: "HTTP全额退款申请",
      confirm: { orderNo: own.order.orderNo, amountFen: own.order.paidAmountFen },
    };
  const quote = CashRefundQuoteSchema.parse(
    await data(
      await request("admin.paymentOrder.refundQuote", creator, { id: own.order.id, body: {} }),
    ),
  );
  expect(quote).toMatchObject({ supported: true, refundableFen: body.confirm.amountFen });
  const created = RefundRequestDetailSchema.parse(
    await data(
      await request("admin.paymentOrder.refundRequest.create", creator, { id: own.order.id, body }),
    ),
  );
  return { ...own, created, body };
}
async function approved() {
  const r = await created(),
    body = {
      lockVersion: 0,
      confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
      confirmChecks: ["rule_amount_checked"],
    };
  const approved = RefundRequestDetailSchema.parse(
    await data(
      await request("admin.refundRequest.approve", approver, {
        id: r.created.refundRequestId,
        body,
      }),
    ),
  );
  expect(approved.status).toBe("pending_execution");
  return { ...r, approved };
}
it("十四入口实际挂载；鉴权/required/版本/回显/stepup失败零业务写，真实签名退款通知完成资金与GET", async () => {
  expect(
    api.api.mounted
      .filter((r) => operations.some((op) => op === r.operationId))
      .map((r) => r.operationId)
      .sort(),
  ).toEqual([...operations].sort());
  const r = await created(),
    id = r.created.refundRequestId,
    tables = [
      "refund_request",
      "refund_txn",
      "ledger_operation",
      "payment_txn",
      "point_ledger_entry",
      "status_transition",
      "outbox_event",
    ];
  const before = await snapshotTables(db, tables);
  await error(
    await request("admin.paymentOrder.refundRequest.create", creator, {
      id: r.order.id,
      body: r.body,
      key: null,
    }),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  const approveBody = {
    lockVersion: 1,
    confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  await error(
    await request("admin.refundRequest.approve", approver, { id, body: approveBody }),
    409,
    "VERSION_CONFLICT",
  );
  expect(await snapshotTables(db, tables)).toEqual(before);
  approveBody.lockVersion = 0;
  await data(await request("admin.refundRequest.approve", approver, { id, body: approveBody }));
  const executeBody = {
    confirm: {
      requestNo: r.created.requestNo,
      amountFen: r.created.amountFen,
      channelTxnNo: r.receipt.channelTxnNo,
    },
    confirmChecks: ["original_txn_checked"],
  };
  const notExecutor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  await error(
    await request("admin.refundRequest.execute", notExecutor, { id, body: executeBody }),
    403,
    "PERMISSION_DENIED",
  );
  const oldStepUp = await signInAsStaff(db, {
    roleKey: "finance",
    now: new Date(api.clock.now().getTime() - 600_001),
  });
  await error(
    await request("admin.refundRequest.execute", oldStepUp, { id, body: executeBody }),
    403,
    "STEP_UP_REQUIRED",
  );
  const wrong = {
    ...executeBody,
    confirm: { ...executeBody.confirm, amountFen: r.created.amountFen + 1 },
  };
  await error(
    await request("admin.refundRequest.execute", executor, { id, body: wrong }),
    409,
    "CONFIRM_MISMATCH",
  );
  const running = RefundRequestDetailSchema.parse(
    await data(await request("admin.refundRequest.execute", executor, { id, body: executeBody })),
  );
  expect(running.status).toBe("executing");
  const txn = running.refundTxns[0]!;
  const notify = provider.completeRefund(txn.outRefundNo),
    wire = provider.encode(notify);
  const signed = () =>
    api.request("/api/v1/hooks/wechatpay/refunds", {
      method: "POST",
      headers: wire.headers,
      body: wire.rawBody,
      peer: `198.19.90.${++peer % 250}`,
    });
  expect((await signed()).status).toBe(200);
  expect((await signed()).status).toBe(200);
  const readBefore = await snapshotTables(db, tables),
    done = RefundRequestDetailSchema.parse(
      await data(await request("admin.refundRequest.get", executor, { id })),
    );
  expect(done.status).toBe("done");
  expect(done.refundTxns[0]?.status).toBe("succeeded");
  RefundRequestPageSchema.parse(
    await data(await request("admin.refundRequest.list", executor, { query: "tab=processed" })),
  );
  RefundSummarySchema.parse(await data(await request("admin.refundRequest.summary", executor)));
  expect(await snapshotTables(db, tables)).toEqual(readBefore);
  const retry = { confirm: { requestNo: done.requestNo, outRefundNo: txn.outRefundNo } };
  await error(
    await request("admin.refundRequest.retry", executor, { id, body: retry }),
    409,
    "STATE_NOT_ALLOWED",
  );
  await error(
    await request("admin.refundRequest.confirmNotAccepted", executor, { id, body: retry }),
    409,
    "STATE_NOT_ALLOWED",
  );
  const invalid = { ...wire.headers, "wechatpay-signature": "not-a-signature" };
  expect(
    (
      await api.request("/api/v1/hooks/wechatpay/refunds", {
        method: "POST",
        headers: invalid,
        body: wire.rawBody,
        peer: "198.19.90.251",
      })
    ).status,
  ).toBe(401);
});
it("驳回/撤回/作废及线下登记均穿真实handler到DB，不能改已回收权益", async () => {
  for (const action of ["reject", "withdraw", "void"] as const) {
    const r = action === "void" ? await approved() : await created(),
      id = r.created.refundRequestId;
    const body =
      action === "void"
        ? {
            note: "未执行人工关闭申请",
            confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
          }
        : { note: "按正式流程关闭退款申请" };
    const result = RefundRequestDetailSchema.parse(
      await data(
        await request(`admin.refundRequest.${action}`, action === "withdraw" ? creator : approver, {
          id,
          body,
        }),
      ),
    );
    expect(result).toMatchObject({
      status: "not_executed",
      closeReason:
        action === "reject" ? "rejected" : action === "withdraw" ? "withdrawn" : "voided",
    });
  }
  const r = await approved(),
    file = await make.fileObject({
      category: "pay_receipt",
      scopeType: "entity",
      entityId: r.entity.id,
      uploadActorType: "staff",
      uploadClient: "admin",
      uploadActorId: executor.staff.id,
      moderationState: "pass",
    }),
    body = {
      transferDate: api.clock.now().toISOString().slice(0, 10),
      bankSerialNo: "HTTP-OFFLINE-REFUND-001",
      payeeName: r.entity.name,
      payeeBank: "公开测试开户行",
      payeeAccount: "6222000000000000",
      receiptFileId: file.id,
      note: "原微信退款改线下并核对凭证",
      confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
      confirmChecks: ["offline_transfer_checked"],
    };
  const done = RefundRequestDetailSchema.parse(
    await data(
      await request("admin.refundRequest.recordOffline", executor, {
        id: r.created.refundRequestId,
        body,
      }),
    ),
  );
  expect(done.status).toBe("done");
  expect(done.refundTxns[0]?.offline?.payeeAccountMask).not.toContain(body.payeeAccount);
  expect((await db.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } })).refundedFen).toBe(
    r.created.amountFen,
  );
});
