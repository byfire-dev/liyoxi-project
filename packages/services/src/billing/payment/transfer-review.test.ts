import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import {
  AdminPaymentOrderCreateBodySchema,
  TransferProofApproveReviewBodySchema,
  TransferProofRejectReviewBodySchema,
} from "@liyoxi/contract";
import type { AdminPaymentOrderCreateBody } from "@liyoxi/contract";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { createRuntime } from "../../runtime.js";
import {
  alertsOf,
  createIdentityContext,
  createIdempotencyContext,
  loadEnv,
  uuidv7,
} from "../../kernel/index.js";
import { proposeFinanceConfig, seedPlaceholderFinanceConfig } from "../index.js";
import { claimTimers, runTimer } from "../../timers/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../../testing/index.js";
import { TransferCheckResultSchema } from "./transfer-ocr.js";

const handle = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let runtime: ReturnType<typeof createRuntime> | undefined;
beforeEach(() => handle.reset(), 60_000);
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});
const identity = (id: string) =>
  createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
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
  "file_ref",
];
async function fixture(ocr = false) {
  const db = await handle.prisma(),
    clock = createClock(new Date("2026-10-09T02:00:00.000Z")),
    providers = createFakeProviders({ clock }),
    make = createFactories({ db, clock });
  const root = createRuntime({
    entry: "api",
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await handle.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
    version: "w404-test",
    clock,
    billingKeyring: TEST_KEYRING,
    redisKeyPrefix: redis.prefix,
    providers: { ...providers, ocr: { ...providers.ocr, configured: ocr } },
  });
  runtime = root;
  const tenant = createTenant({
    tx: root.tx,
    clock,
    flow: createFlow({ assembly: root.assembly, clock, events: root.events }),
    assembly: root.assembly,
  });
  async function staff(role: "super_admin" | "finance" | "delivery_manager" = "finance") {
    const row = await make.staff({ staffRoleKey: role });
    return {
      row,
      ctx: identity(row.id),
      staff: await sampleStaffContext(db, row.id, { stepUpAt: clock.now() }),
    };
  }
  const creator = await staff("super_admin"),
    first = await staff(),
    second = await staff();
  await seedPlaceholderFinanceConfig(
    {
      tx: root.tx,
      clock,
      assembly: root.assembly,
      bizNo: root.bizNo,
      keyring: TEST_KEYRING,
    },
    { proposerId: first.row.id, approverId: second.row.id },
  );
  async function controls(adminCreateOrder: boolean, receiptSecondReviewFen: number | null) {
    clock.advance(1);
    const proposal = await root.tx.run((tx) =>
      proposeFinanceConfig(
        tx,
        { approval: root.approval, clock, keyring: TEST_KEYRING },
        first.ctx,
        {
          configKey: "controls",
          payload: { ...DEFAULT_CONTROLS, adminCreateOrder, receiptSecondReviewFen },
          changeNote: "本轮虚构收款门槛",
        },
        first.staff,
      ),
    );
    await root.tx.run((tx) =>
      root.approval.approve(tx, second.ctx, {
        approvalId: proposal.approvalId,
        lockVersion: 0,
        staff: second.staff,
      }),
    );
  }
  async function orderInput() {
    const own = await make.merchant({ verified: true }),
      plan = await db.plan.findUniqueOrThrow({ where: { code: "pro" } });
    const membership = await root.tx.run((tx) =>
      tenant.resolveMembership(tx, { merchantUserId: own.user.id, storeId: own.store.id }),
    );
    if (!membership) throw new Error("本轮真实老板关系缺失");
    const quote = await root.billing.quotePlanPurchase(
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
    const input: AdminPaymentOrderCreateBody = {
      entityId: own.entity.id,
      storeId: own.store.id,
      kind: "plan",
      planId: plan.id,
      months: 1,
      expectAmountFen: quote.payFen,
      contractNo: `W404-${uuidv7()}`,
      confirm: { entityName: own.entity.name!, amountFen: quote.payFen },
    };
    return { own, input };
  }
  async function createOrder() {
    const target = await orderInput();
    const order = await root.billing.createAdminOrder(creator.ctx, creator.staff, target.input);
    return { ...target, order };
  }
  async function file(entityId: string, ext = "png", uploader = first.row.id) {
    const mime = ext === "webp" ? "image/webp" : "image/png";
    const row = await make.fileObject({
      bucket: "secure",
      category: "pay_receipt",
      scopeType: "entity",
      entityId,
      storeId: null,
      ext,
      etag: "fictional-receipt-etag",
      mime,
      declaredMime: mime,
      uploadActorType: "staff",
      uploadActorId: uploader,
      uploadClient: "admin",
    });
    providers.storage.put({ bucket: "secure", key: row.objectKey }, new Uint8Array(1024), mime);
    return row;
  }
  async function submit(target: Awaited<ReturnType<typeof createOrder>>, ext = "png") {
    const uploaded = await file(target.own.entity.id, ext);
    const proof = await root.billing.createAdminTransferProof(
      first.ctx,
      first.staff,
      target.order.paymentOrderId,
      { fileId: uploaded.id, note: "本轮虚构凭证" },
    );
    return { ...target, file: uploaded, proof };
  }
  function confirm(target: Awaited<ReturnType<typeof submit>>, bankSerialNo = uuidv7()) {
    return {
      lockVersion: target.proof.lockVersion,
      bankSerialNo,
      confirmChecks: ["bank_statement_checked"],
      confirm: {
        orderNo: target.order.orderNo,
        receivedAmountFen: target.order.amountFen,
      },
    };
  }
  function approve(target: Awaited<ReturnType<typeof submit>>, approvalId: string) {
    return {
      approvalId,
      lockVersion: 0,
      confirmChecks: ["bank_statement_checked"],
      confirm: { orderNo: target.order.orderNo, receivedAmountFen: target.order.amountFen },
    };
  }
  async function money(entityId: string) {
    return {
      transactions: await db.paymentTxn.count({ where: { entityId } }),
      ledger: await db.pointLedgerEntry.count({ where: { entityId } }),
      terms: await db.subscriptionTerm.count({ where: { entityId } }),
    };
  }
  async function deliver(name: string, eventId: string) {
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    const subscriber = root.assembly.subscriber(name);
    if (!subscriber) throw new Error("真实订阅登记缺失");
    return root.tx.run((tx) =>
      subscriber.handle(tx, {
        id: row.id,
        type: row.eventType,
        payload: z.record(z.string(), z.unknown()).parse(row.payload),
      }),
    );
  }
  async function invariants(entityId: string) {
    for (const rule of root.assembly.invariants.filter(
      (r) => r.code.startsWith("payment.") || r.code.startsWith("approval."),
    )) {
      if (rule.run)
        expect(
          await root.tx.run((tx) => rule.run!(tx, { entityIds: [entityId] }, { now: clock.now() })),
          rule.code,
        ).toEqual([]);
    }
  }
  return {
    db,
    root,
    clock,
    make,
    providers,
    creator,
    first,
    second,
    staff,
    controls,
    orderInput,
    createOrder,
    file,
    submit,
    confirm,
    approve,
    money,
    deliver,
    invariants,
  };
}

it("代建受控开关/回显/权限与文件归属零写，C50重放前复核真实员工", async () => {
  const h = await fixture(),
    target = await h.orderInput();
  const before = await snapshotTables(h.db, tables);
  await expect(
    h.root.billing.createAdminOrder(h.creator.ctx, h.creator.staff, target.input),
  ).rejects.toMatchObject({ error: "OFFLINE_ORDER_DISABLED" });
  expect(await snapshotTables(h.db, tables)).toEqual(before);
  await h.controls(true, null);
  const forbidden = await h.staff("delivery_manager");
  await expect(
    h.root.billing.createAdminOrder(forbidden.ctx, forbidden.staff, target.input),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  const clean = await snapshotTables(h.db, tables);
  for (const bad of [
    { ...target.input, expectAmountFen: target.input.expectAmountFen + 1 },
    { ...target.input, confirm: { ...target.input.confirm, entityName: "错误回显" } },
  ])
    await expect(
      h.root.billing.createAdminOrder(h.creator.ctx, h.creator.staff, bad),
    ).rejects.toBeDefined();
  expect(
    AdminPaymentOrderCreateBodySchema.safeParse({ ...target.input, contractNo: "" }).success,
  ).toBe(false);
  expect(await snapshotTables(h.db, tables)).toEqual(clean);
  const key = uuidv7();
  const idem = () =>
    createIdempotencyContext({
      mode: "required",
      scope: "admin.paymentOrder.create",
      actor: h.creator.ctx.actor,
      key,
      request: { method: "POST", body: target.input },
    });
  const order = await h.root.billing.createAdminOrder(
    h.creator.ctx,
    h.creator.staff,
    target.input,
    { idem: idem() },
  );
  const created = await snapshotTables(h.db, tables);
  expect(
    await h.root.billing.createAdminOrder(h.creator.ctx, h.creator.staff, target.input, {
      idem: idem(),
    }),
  ).toEqual(order);
  expect(await snapshotTables(h.db, tables)).toEqual(created);
  const foreign = await h.make.merchant({ verified: true });
  for (const file of [
    await h.file(foreign.entity.id),
    await h.file(target.own.entity.id, "png", h.second.row.id),
  ]) {
    const frozen = await snapshotTables(h.db, tables);
    await expect(
      h.root.billing.createAdminTransferProof(h.first.ctx, h.first.staff, order.paymentOrderId, {
        fileId: file.id,
      }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
    expect(await snapshotTables(h.db, tables)).toEqual(frozen);
  }
  await h.db.staff.update({
    where: { id: h.creator.row.id },
    data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
  });
  const disabled = await snapshotTables(h.db, tables);
  await expect(
    h.root.billing.createAdminOrder(h.creator.ctx, h.creator.staff, target.input, { idem: idem() }),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await snapshotTables(h.db, tables)).toEqual(disabled);
});

it("阈值下原确认入账；阈值上首确认零收款，第二人CAS/C50只到账履约一次", async () => {
  const h = await fixture();
  await h.controls(true, null);
  const small = await h.submit(await h.createOrder());
  expect(
    (
      await h.root.billing.confirmProof(
        h.first.ctx,
        h.first.staff,
        small.proof.transferProofId,
        h.confirm(small),
      )
    ).outcome,
  ).toBe("paid");
  await h.invariants(small.own.entity.id);
  await h.controls(true, 1);
  const large = await h.submit(await h.createOrder()),
    body = h.confirm(large);
  const zero = await h.money(large.own.entity.id);
  await expect(
    h.root.billing.confirmProof(h.creator.ctx, h.creator.staff, large.proof.transferProofId, body),
  ).rejects.toMatchObject({ error: "CONFIRMER_IS_ORDER_CREATOR" });
  const first = await h.root.billing.confirmProof(
    h.first.ctx,
    h.first.staff,
    large.proof.transferProofId,
    body,
  );
  expect(first.outcome).toBe("review_pending");
  expect(await h.money(large.own.entity.id)).toEqual(zero);
  expect(
    await h.db.billingOrder.findUniqueOrThrow({ where: { id: large.order.paymentOrderId } }),
  ).toMatchObject({
    status: "pending_confirmation",
    transferState: "confirm_review",
    fulfillmentStatus: "none",
  });
  const approvalId = first.review!.approvalId,
    approve = h.approve(large, approvalId);
  await expect(
    h.root.billing.approveTransferReview(
      h.first.ctx,
      h.first.staff,
      large.proof.transferProofId,
      approve,
    ),
  ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  await expect(
    h.root.billing.approveTransferReview(
      h.second.ctx,
      h.second.staff,
      large.proof.transferProofId,
      { ...approve, lockVersion: 1 },
    ),
  ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    h.root.billing.approveTransferReview(
      h.second.ctx,
      h.second.staff,
      large.proof.transferProofId,
      {
        ...approve,
        confirm: { ...approve.confirm, receivedAmountFen: approve.confirm.receivedAmountFen + 1 },
      },
    ),
  ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
  expect(await h.money(large.own.entity.id)).toEqual(zero);
  const key = uuidv7(),
    idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.transferProof.approveReview",
        actor: h.second.ctx.actor,
        key,
        request: { method: "POST", body: approve },
      });
  expect(
    (
      await h.root.billing.approveTransferReview(
        h.second.ctx,
        h.second.staff,
        large.proof.transferProofId,
        approve,
        { idem: idem() },
      )
    ).outcome,
  ).toBe("paid");
  const paid = await snapshotTables(h.db, tables);
  await h.root.billing.approveTransferReview(
    h.second.ctx,
    h.second.staff,
    large.proof.transferProofId,
    approve,
    { idem: idem() },
  );
  expect(await snapshotTables(h.db, tables)).toEqual(paid);
  expect(await h.money(large.own.entity.id)).toMatchObject({ transactions: 1, terms: 1 });
  expect(
    await h.db.paymentTxn.findFirstOrThrow({
      where: { billingOrderId: large.order.paymentOrderId },
    }),
  ).toMatchObject({
    confirmedByStaffId: h.first.row.id,
    reviewedByStaffId: h.second.row.id,
    appliedAt: h.clock.now(),
  });
  expect(
    await h.db.auditLog.count({
      where: {
        action: "billing.transfer_proof.approve_review",
        targetId: large.proof.transferProofId,
      },
    }),
  ).toBe(1);
  await h.invariants(large.own.entity.id);
});

it("复核退回不到账且能新轮重提，旧approvalId不能处理新轮或替代凭证", async () => {
  const h = await fixture();
  await h.controls(true, 1);
  const target = await h.submit(await h.createOrder()),
    id = target.proof.transferProofId;
  const first = await h.root.billing.confirmProof(
    h.first.ctx,
    h.first.staff,
    id,
    h.confirm(target),
  );
  const oldId = first.review!.approvalId;
  expect(
    TransferProofApproveReviewBodySchema.safeParse({
      ...h.approve(target, oldId),
      approvalId: undefined,
    }).success,
  ).toBe(false);
  expect(TransferProofRejectReviewBodySchema.safeParse({ note: "无轮次" }).success).toBe(false);
  await h.root.billing.rejectTransferReview(h.second.ctx, h.second.staff, id, {
    approvalId: oldId,
    note: "请重新核对流水",
  });
  expect(await h.money(target.own.entity.id)).toEqual({ transactions: 0, ledger: 0, terms: 0 });
  const current = await h.root.billing.getProof(h.first.staff, id);
  const second = await h.root.billing.confirmProof(h.first.ctx, h.first.staff, id, {
    ...h.confirm(target),
    lockVersion: current.lockVersion,
  });
  const nextId = second.review!.approvalId;
  expect(nextId).not.toBe(oldId);
  expect((await h.db.approvalRequest.findUniqueOrThrow({ where: { id: nextId } })).roundNo).toBe(2);
  const frozen = await snapshotTables(h.db, tables);
  await expect(
    h.root.billing.approveTransferReview(
      h.second.ctx,
      h.second.staff,
      id,
      h.approve(target, oldId),
    ),
  ).rejects.toMatchObject({ error: "APPROVAL_NOT_PENDING" });
  await expect(
    h.root.billing.rejectTransferReview(h.second.ctx, h.second.staff, id, {
      approvalId: oldId,
      note: "旧面板",
    }),
  ).rejects.toMatchObject({ error: "APPROVAL_NOT_PENDING" });
  const anotherFile = await h.file(target.own.entity.id);
  await expect(
    h.root.billing.createAdminTransferProof(
      h.first.ctx,
      h.first.staff,
      target.order.paymentOrderId,
      { fileId: anotherFile.id },
    ),
  ).rejects.toMatchObject({ error: "TRANSFER_PROOF_LOCKED" });
  expect(await snapshotTables(h.db, tables)).toEqual(frozen);
  await h.root.billing.rejectTransferReview(h.second.ctx, h.second.staff, id, {
    approvalId: nextId,
    note: "重新上传",
  });
  const replacement = await h.root.billing.createAdminTransferProof(
    h.first.ctx,
    h.first.staff,
    target.order.paymentOrderId,
    { fileId: anotherFile.id },
  );
  expect(replacement.transferProofId).not.toBe(id);
  expect((await h.db.transferProof.findUniqueOrThrow({ where: { id } })).reviewStatus).toBe(
    "superseded",
  );
  await expect(
    h.root.billing.approveTransferReview(
      h.second.ctx,
      h.second.staff,
      replacement.transferProofId,
      h.approve(target, nextId),
    ),
  ).rejects.toMatchObject({ error: "APPROVAL_NOT_PENDING" });
  await h.invariants(target.own.entity.id);
});

it("同一规范银行流水并发只有一笔真实收款，另一主体零到账且不变量保持", async () => {
  const h = await fixture();
  await h.controls(true, null);
  const a = await h.submit(await h.createOrder()),
    b = await h.submit(await h.createOrder());
  const serial = `W404${uuidv7().replaceAll("-", "")}`;
  const results = await Promise.allSettled([
    h.root.billing.confirmProof(
      h.first.ctx,
      h.first.staff,
      a.proof.transferProofId,
      h.confirm(a, serial),
    ),
    h.root.billing.confirmProof(
      h.second.ctx,
      h.second.staff,
      b.proof.transferProofId,
      h.confirm(b, serial.toLowerCase()),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
    error: "BANK_SERIAL_DUPLICATE",
  });
  expect(await h.db.paymentTxn.count({ where: { channelTxnNo: serial.toUpperCase() } })).toBe(1);
  const money = [await h.money(a.own.entity.id), await h.money(b.own.entity.id)];
  expect(money.map((m) => m.transactions).sort()).toEqual([0, 1]);
  await h.invariants(a.own.entity.id);
  await h.invariants(b.own.entity.id);
});

it("回单真实任务完成与缓存只写四项结论，错job/替代凭证迟到零写，WebP保留且不假识别", async () => {
  const h = await fixture(true);
  await h.controls(true, 1);
  const target = await h.submit(await h.createOrder());
  h.providers.ocr.defaultReceipt = {
    payerName: target.own.entity.name,
    payerAccount: "1234567890123456",
    payeeName: "演示收款户",
    amountFen: target.order.amountFen + 1,
    remark: target.order.orderNo,
    tradedAt: new Date(h.clock.now().getTime() + 1000).toISOString(),
    warnings: [],
    raw: "W404_PRIVATE_OCR_RAW",
  };
  const row = await h.db.transferProof.findUniqueOrThrow({
    where: { id: target.proof.transferProofId },
  });
  expect(row.ocrResultId).not.toBeNull();
  const job = await h.db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `ocr:bank_receipt:${row.ocrResultId}` },
  });
  await h.root.media.jobs.run({ jobId: job.id });
  const event = await h.db.outboxEvent.findFirstOrThrow({
    where: { eventType: "media.ocr.completed", aggregateId: row.ocrResultId! },
  });
  await h.deliver("billing.onOcrCompleted", event.id);
  const updated = await h.db.transferProof.findUniqueOrThrow({ where: { id: row.id } });
  expect(TransferCheckResultSchema.parse(updated.checkResult).items.map((i) => i.result)).toEqual([
    "pass",
    "fail",
    "pass",
    "pass",
  ]);
  expect(JSON.stringify(updated.checkResult)).not.toContain(target.own.entity.name!);
  expect(JSON.stringify(updated.checkResult)).not.toContain("1234567890123456");
  const view = await h.root.billing.getProof(h.first.staff, row.id);
  expect(view.ocr.recognized?.payerAccountMask).toBe("****3456");
  expect(JSON.stringify(view)).not.toContain("1234567890123456");
  expect(JSON.stringify(view)).not.toContain("W404_PRIVATE_OCR_RAW");
  expect(await h.money(target.own.entity.id)).toEqual({ transactions: 0, ledger: 0, terms: 0 });
  const cached = await h.root.billing.createAdminTransferProof(
    h.first.ctx,
    h.first.staff,
    target.order.paymentOrderId,
    { fileId: target.file.id },
  );
  expect(cached.ocr.status).toBe("ok");
  expect(cached.checks.map((i) => i.result)).toEqual(["pass", "fail", "pass", "pass"]);
  expect(h.providers.ocr.callsOf("recognizeBankReceipt")).toHaveLength(1);
  const webp = await h.submit(target, "webp");
  expect(webp.proof.ocr.status).toBe("unavailable");
  expect(webp.proof.checks.every((i) => i.result === "unknown")).toBe(true);
  expect(
    (await h.db.transferProof.findUniqueOrThrow({ where: { id: webp.proof.transferProofId } }))
      .ocrResultId,
  ).toBeNull();
  const frozen = await snapshotTables(h.db, tables);
  await h.deliver("billing.onOcrCompleted", event.id);
  const subscriber = h.root.assembly.subscriber("billing.onOcrCompleted")!;
  await h.root.tx.run((tx) =>
    subscriber.handle(tx, {
      id: uuidv7(),
      type: "media.ocr.completed",
      payload: { ...z.record(z.string(), z.unknown()).parse(event.payload), mediaJobId: uuidv7() },
    }),
  );
  expect(await snapshotTables(h.db, tables)).toEqual(frozen);
  await h.root.close();
  runtime = undefined;
  await handle.reset();
  const off = await fixture(false);
  await off.controls(true, null);
  const legacy = await off.submit(await off.createOrder(), "webp");
  expect(legacy.proof.ocr.status).toBe("unavailable");
});

it("日历真实导入重算唯一SLA并取消旧timer，当前到期才发finance消息，替代/终态不再提醒", async () => {
  const h = await fixture();
  await h.controls(true, null);
  const target = await h.submit(await h.createOrder()),
    id = target.proof.transferProofId;
  const before = await h.db.transferProof.findUniqueOrThrow({ where: { id } });
  const originalTimer = await h.db.timer.findFirstOrThrow({
    where: { kind: "sla.breach", subjectId: id, status: "scheduled" },
  });
  const imported = await h.root.calendarAdmin.import(
    { identity: h.creator.ctx, staff: h.creator.staff },
    {
      year: 2026,
      source: "本轮虚构日历修正",
      days: [{ date: "2026-10-10", kind: "holiday", note: "演练休息日" }],
    },
  );
  expect(imported.isChanged).toBe(true);
  const event = await h.db.outboxEvent.findFirstOrThrow({
    where: { eventType: "calendar.imported" },
    orderBy: { createdAt: "desc" },
  });
  await h.deliver("billing.onCalendarImported", event.id);
  const changed = await h.db.transferProof.findUniqueOrThrow({ where: { id } });
  expect(changed.dueAt!.getTime()).toBeGreaterThan(before.dueAt!.getTime());
  expect(changed.slaSnapshot).toMatchObject({ calendarVersion: imported.calendar.calendarVersion });
  expect((await h.db.timer.findUniqueOrThrow({ where: { id: originalTimer.id } })).status).toBe(
    "cancelled",
  );
  const current = await h.db.timer.findFirstOrThrow({
    where: { kind: "sla.breach", subjectId: id, status: "scheduled" },
  });
  const futureEvent = {
    id: uuidv7(),
    type: "transfer.sla_breached",
    payload: {
      v: 1,
      transferProofId: id,
      billingOrderId: target.order.paymentOrderId,
      entityId: target.own.entity.id,
      dueAt: changed.dueAt!.toISOString(),
    },
  };
  await h.root.tx.run((tx) => h.root.notify.onEvent(tx, futureEvent));
  expect(
    await h.db.notification.count({ where: { bizId: id, notifySceneKey: "s.finance_overdue" } }),
  ).toBe(0);
  h.clock.set(changed.dueAt!);
  const refs = await h.root.tx.run((tx) => claimTimers(tx, h.root.timers.registry, h.clock.now()));
  const ref = refs.claimed.find((r) => r.timerId === current.id);
  expect(ref).toBeDefined();
  expect(
    await runTimer(
      {
        tx: h.root.tx,
        assembly: h.root.assembly,
        registry: h.root.timers.registry,
        clock: h.clock,
        alerts: alertsOf(h.root.assembly),
      },
      ref!,
    ),
  ).toBe("fired");
  const breached = await h.db.outboxEvent.findFirstOrThrow({
    where: { eventType: "transfer.sla_breached", aggregateId: id },
  });
  await h.deliver("notify.onEvent", breached.id);
  const notices = await h.db.notification.findMany({
    where: { bizId: id, notifySceneKey: "s.finance_overdue" },
  });
  expect(notices.length).toBeGreaterThan(0);
  expect(
    await h.db.staffMessage.count({
      where: {
        notificationId: { in: notices.map((n) => n.id) },
        staffId: { in: [h.first.row.id, h.second.row.id] },
      },
    }),
  ).toBe(2);
  const first = await h.root.billing.getProof(h.first.staff, id);
  await h.root.billing.confirmProof(
    h.first.ctx,
    await sampleStaffContext(h.db, h.first.row.id, { stepUpAt: h.clock.now() }),
    id,
    { ...h.confirm(target), lockVersion: first.lockVersion },
  );
  const frozen = await snapshotTables(h.db, ["notification", "staff_message", "payment_txn"]);
  await h.deliver("notify.onEvent", breached.id);
  expect(await snapshotTables(h.db, ["notification", "staff_message", "payment_txn"])).toEqual(
    frozen,
  );
  const fallback = await h.root.tx.run((tx) =>
    createSla({ clock: h.clock, assembly: h.root.assembly }).dueAt(tx, {
      policy: "review.transfer_proof",
      amount: 1,
      unit: "work_days",
      from: new Date("2031-02-03T02:00:00.000Z"),
      workHours: { start: "09:00", end: "18:00" },
    }),
  );
  expect(fallback.fallbackDates.length).toBeGreaterThan(0);
  expect(fallback.snapshot.policy).toBe("review.transfer_proof");
});
