import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { createRuntime } from "../../runtime.js";
import {
  createIdentityContext,
  createIdempotencyContext,
  createTxRunner,
  lockRows,
  loadEnv,
  uuidv7,
} from "../../kernel/index.js";
import type { Assembly, IdentityContext } from "../../kernel/index.js";
import { createTenant } from "../../tenant/index.js";
import { createFlow } from "../../flow/index.js";
import { placeholderPdf } from "../../media/index.js";
import { claimTimers } from "../../timers/index.js";
import { createSla, workHoursAt } from "../../sla/index.js";
import {
  markInvoiceRedPending,
  cancelInvoiceRed,
  readInvoiceRefundGuard,
  proposeFinanceConfig,
  seedPlaceholderFinanceConfig,
} from "../index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  createTestWorkerServices,
  fakeKeyEnv,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../../testing/index.js";

const handle = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let runtime: ReturnType<typeof createRuntime> | undefined;
type WorkerServices = ReturnType<typeof createTestWorkerServices>;
let worker: WorkerServices | undefined;
beforeEach(() => handle.reset(), 60_000);
afterEach(async () => {
  const owned = worker;
  worker = undefined;
  const results = await Promise.allSettled([
    owned?.shutdownMediaJobs?.(),
    owned?.closeNotify(),
    owned?.closeDocs(),
    owned?.documentConverter?.close(),
    owned?.closeAnalytics?.(),
    owned?.closeStaff?.(),
    owned?.closeSmsHealth?.(),
    owned?.closeAlertFacts?.(),
    owned?.closeProfile?.(),
    owned?.closeModelBudget?.(),
    owned?.closeProbes?.(),
    owned?.closeCertificates?.(),
    owned?.closeBackups?.(),
    owned?.closeAlertDispatcher?.(),
    owned?.closeStorageDrivers?.(),
    owned?.closeMediaDrivers?.(),
    owned?.closeModelDrivers?.(),
    owned?.closeServerErrors?.(),
  ]);
  owned?.closeMediaJobs?.();
  owned?.closeApproval?.();
  owned?.closeInvitations?.();
  owned?.closeOrder?.();
  owned?.closeBillingTimers?.();
  owned?.closePublish?.();
  owned?.closeDelivery?.();
  owned?.closeWebhooks?.();
  await runtime?.close();
  runtime = undefined;
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "本轮worker关闭失败",
    );
});
const tables = [
  "invoice_request",
  "invoice_doc",
  "file_ref",
  "billing_order",
  "payment_txn",
  "point_ledger_entry",
  "audit_log",
  "outbox_event",
  "timer",
];
const email = "w413-receipt@example.invalid";
function idem(ctx: IdentityContext, scope: string, body: unknown, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope,
    actor: ctx.actor,
    key,
    request: { method: "POST", body },
  });
}

async function fixture(mailConfigured = true, at = new Date("2040-01-09T02:00:00Z")) {
  const db = await handle.prisma(),
    clock = createClock(at);
  const providers = createFakeProviders({ clock }),
    make = createFactories({ db, clock });
  const env = {
    ...loadEnv({
      APP_ENV: "test",
      DATABASE_URL: await handle.url(),
      REDIS_URL: process.env.REDIS_URL,
    }),
    ...fakeKeyEnv(),
  };
  const configured = {
    ...providers,
    mail: mailConfigured
      ? providers.mail
      : { ...providers.mail, configured: false, status: "unconfigured" },
  };
  const root = createRuntime({
    entry: "api",
    version: "w413-invoice-test",
    env,
    clock,
    billingKeyring: TEST_KEYRING,
    redisKeyPrefix: redis.prefix,
    providers: configured,
  });
  runtime = root;
  async function staff(role: "super_admin" | "finance" | "delivery_manager" = "finance") {
    const row = await make.staff({ staffRoleKey: role });
    return {
      row,
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
      staff: await sampleStaffContext(db, row.id, { stepUpAt: clock.now() }),
    };
  }
  const creator = await staff("super_admin"),
    first = await staff(),
    second = await staff();
  await seedPlaceholderFinanceConfig(
    { tx: root.tx, clock, assembly: root.assembly, bizNo: root.bizNo, keyring: TEST_KEYRING },
    { proposerId: first.row.id, approverId: second.row.id },
  );
  clock.advance(1);
  const controls = await root.tx.run((tx) =>
    proposeFinanceConfig(
      tx,
      { approval: root.approval, clock, keyring: TEST_KEYRING },
      first.ctx,
      {
        configKey: "controls",
        payload: { ...DEFAULT_CONTROLS, adminCreateOrder: true, receiptSecondReviewFen: null },
        changeNote: "本轮发票真实收款准备",
      },
      first.staff,
    ),
  );
  await root.tx.run((tx) =>
    root.approval.approve(tx, second.ctx, {
      approvalId: controls.approvalId,
      lockVersion: 0,
      staff: second.staff,
    }),
  );
  // Configuration fixtures supply the four deployment-specific names; no business state is fabricated.
  await db.paramValue.createMany({
    data: ["plan_new", "plan_renew", "plan_upgrade", "topup"].map((type) => ({
      id: uuidv7(),
      key: `invoice.item_name.${type}`,
      value: "本轮虚构技术服务",
      effectiveAt: clock.now(),
      createdByStaffId: creator.row.id,
      createdAt: clock.now(),
    })),
  });
  await db.notifyScene.upsert({
    where: { sceneKey: "m.invoice_issued" },
    create: {
      sceneKey: "m.invoice_issued",
      audience: "merchant",
      name: "本轮开票通知",
      sceneEnabled: true,
      extEnabled: true,
      sendWindow: "immediate",
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
    update: {
      sceneEnabled: true,
      extEnabled: true,
      sendWindow: "immediate",
      updatedAt: clock.now(),
    },
  });
  const tenant = createTenant({
    tx: root.tx,
    clock,
    flow: createFlow({ assembly: root.assembly, clock, events: root.events }),
    assembly: root.assembly,
  });
  async function merchant() {
    const own = await make.merchant({ verified: true });
    const membership = await root.tx.run((tx) =>
      tenant.resolveMembership(tx, { merchantUserId: own.user.id, storeId: own.store.id }),
    );
    if (!membership) throw new Error("本轮真实老板关系缺失");
    return {
      ...own,
      actor: {
        membership,
        ctx: createIdentityContext({
          actor: { type: "merchant", id: own.user.id, client: "weapp", role: "owner" },
          entityId: own.entity.id,
          storeId: own.store.id,
        }),
      },
    };
  }
  async function file(entityId: string, category: "invoice" | "pay_receipt") {
    const bytes =
      category === "invoice"
        ? placeholderPdf("W413-INVOICE-TEST")
        : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const actor = { identity: first.ctx, staff: first.staff };
    const registered = (
      await root.media.register(actor, {
        category,
        entityId,
        files: [
          {
            fileName: category === "invoice" ? "invoice.pdf" : "receipt.png",
            sizeBytes: String(bytes.byteLength),
            clientToken: uuidv7(),
          },
        ],
      })
    ).items[0]!;
    const pending = await db.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } });
    expect(pending.incomingBucket).toBe("secure");
    providers.storage.put(
      { bucket: "secure", key: registered.key },
      bytes,
      category === "invoice" ? "application/pdf" : "image/png",
    );
    await root.media.complete(actor, registered.fileId);
    const job = await db.mediaJob.findFirstOrThrow({
      where: { kind: "promote", subjectType: "file_object", subjectId: registered.fileId },
    });
    await root.media.jobs.run({ jobId: job.id });
    const stored = await db.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } });
    expect(stored.status).toBe("stored");
    return { row: stored, bytes };
  }
  async function paid(existing?: Awaited<ReturnType<typeof merchant>>) {
    const own = existing ?? (await merchant()),
      plan = await db.plan.findUniqueOrThrow({ where: { code: "pro" } });
    const quote = await root.billing.quotePlanPurchase(
      own.actor,
      { platform: "android" },
      { planId: plan.id, months: 1 },
    );
    const order = await root.billing.createAdminOrder(creator.ctx, creator.staff, {
      entityId: own.entity.id,
      storeId: own.store.id,
      kind: "plan",
      planId: plan.id,
      months: 1,
      expectAmountFen: quote.payFen,
      contractNo: `W413-${uuidv7()}`,
      confirm: { entityName: own.entity.name!, amountFen: quote.payFen },
    });
    const receipt = await file(own.entity.id, "pay_receipt");
    const proof = await root.billing.createAdminTransferProof(
      first.ctx,
      first.staff,
      order.paymentOrderId,
      { fileId: receipt.row.id, note: "本轮虚构银行凭证" },
    );
    await root.billing.confirmProof(first.ctx, first.staff, proof.transferProofId, {
      lockVersion: proof.lockVersion,
      bankSerialNo: uuidv7(),
      confirmChecks: ["bank_statement_checked"],
      confirm: { orderNo: order.orderNo, receivedAmountFen: order.amountFen },
    });
    const current = await db.billingOrder.findUniqueOrThrow({
      where: { id: order.paymentOrderId },
    });
    expect(current).toMatchObject({
      status: "paid",
      fulfillmentStatus: "done",
      paidAmountFen: quote.payFen,
    });
    return { own, order, current };
  }
  async function request(target: Awaited<ReturnType<typeof paid>>) {
    return root.billing.invoices.create(target.own.actor, {
      paymentOrderId: target.current.id,
      invoiceType: "normal",
      medium: "electronic",
      recvEmail: email,
    });
  }
  async function issue(
    request: Awaited<ReturnType<typeof root.billing.invoices.create>>,
    fileId: string,
    invoiceNo = "20400000000000000001",
  ) {
    return root.billing.invoices.issue(first.ctx, first.staff, request.invoiceRequestId, {
      invoiceNo,
      fileId,
      confirm: { requestNo: request.requestNo, amountFen: request.amountFen },
    });
  }
  const sourceTx = createTxRunner({ prisma: db, appEnv: "test" });
  async function deliver(name: string, eventId: string, assembly: Assembly = root.assembly) {
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    const subscriber = assembly.subscriber(name);
    if (!subscriber) throw new Error("本轮真实订阅登记缺失");
    await sourceTx.run((tx) =>
      subscriber.handle(tx, {
        id: row.id,
        type: row.eventType,
        payload: z.record(z.string(), z.unknown()).parse(row.payload),
      }),
    );
  }
  function actualWorker() {
    if (worker) throw new Error("本轮worker已存在");
    worker = createTestWorkerServices({
      prisma: db,
      assembly: assembleForTest({ entry: "worker" }),
      clock,
      keys: env,
      providers: configured,
      sessionMutex: root.sessionMutex,
      channel: { enqueue: async () => {}, downForMs: () => 0 },
    });
    return worker;
  }
  async function notify(docId: string, services?: WorkerServices) {
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "invoice.issued", aggregateId: docId },
    });
    await deliver("notify.onEvent", event.id, services?.assembly);
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { channel: "mail", notification: { bizType: "invoice_doc", bizId: docId } },
      orderBy: { resendNo: "desc" },
    });
    await (services
      ? services.notifyDeliver({ deliveryId: delivery.id })
      : root.notify.deliver({ deliveryId: delivery.id }));
    const result = await db.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: delivery.id,
        eventType: { in: ["notify.mail_delivered", "notify.mail_failed"] },
      },
      orderBy: { createdAt: "desc" },
    });
    await deliver("billing.onMailResult", result.id, services?.assembly);
    return {
      delivery: await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      result,
    };
  }
  return {
    db,
    root,
    clock,
    providers,
    make,
    first,
    second,
    creator,
    staff,
    merchant,
    file,
    paid,
    request,
    issue,
    deliver,
    actualWorker,
    notify,
  };
}

it("真实收款申请、拒绝后重提、权限零写、密文快照与PDF可下载，未配邮件按worker事实skipped", async () => {
  const h = await fixture(false),
    target = await h.paid(),
    invoices = h.root.billing.invoices;
  const input = {
    paymentOrderId: target.current.id,
    invoiceType: "normal" as const,
    medium: "electronic" as const,
    recvEmail: email,
  };
  const key = uuidv7(),
    request = await invoices.create(target.own.actor, input, {
      idem: idem(target.own.actor.ctx, "m.invoiceRequest.create", input, key),
    });
  const before = await snapshotTables(h.db, tables);
  expect(
    (
      await invoices.create(target.own.actor, input, {
        idem: idem(target.own.actor.ctx, "m.invoiceRequest.create", input, key),
      })
    ).invoiceRequestId,
  ).toBe(request.invoiceRequestId);
  const other = await h.merchant();
  await expect(invoices.create(other.actor, input)).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(invoices.create(target.own.actor, input)).rejects.toMatchObject({
    error: "INVOICE_REQUEST_EXISTS",
  });
  expect(await snapshotTables(h.db, tables)).toEqual(before);
  const row = await h.db.invoiceRequest.findUniqueOrThrow({
    where: { id: request.invoiceRequestId },
  });
  expect(row).toMatchObject({
    title: target.own.entity.name,
    itemName: "本轮虚构技术服务",
    status: "pending",
  });
  expect(row.recvEmailEnc).toBeTruthy();
  expect(row.recvEmailEnc).not.toContain(email);
  expect(JSON.stringify(request)).not.toContain(email);
  const reason = await h.db.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "invoice" },
    },
  });
  await invoices.reject(h.first.ctx, h.first.staff, row.id, {
    reasonCode: reason.code,
    note: "本轮核对后重提",
  });
  const again = await h.request(target);
  expect(again.invoiceRequestId).not.toBe(row.id);
  expect((await h.db.invoiceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
    "rejected",
  );
  const pdf = await h.file(target.own.entity.id, "invoice"),
    outsider = await h.staff("delivery_manager");
  const issueInput = {
    invoiceNo: "20400000000000000001",
    fileId: pdf.row.id,
    confirm: { requestNo: again.requestNo, amountFen: again.amountFen },
  };
  const issueBefore = await snapshotTables(h.db, tables);
  await expect(
    invoices.issue(outsider.ctx, outsider.staff, again.invoiceRequestId, issueInput),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await snapshotTables(h.db, tables)).toEqual(issueBefore);
  const competingOrder = await h.paid(other),
    competingRequest = await h.request(competingOrder);
  const competingPdf = await h.file(other.entity.id, "invoice");
  const competingInput = {
    ...issueInput,
    fileId: competingPdf.row.id,
    confirm: { requestNo: competingRequest.requestNo, amountFen: competingRequest.amountFen },
  };
  h.clock.set(new Date("2040-03-31T15:59:59Z"));
  h.first.staff = await sampleStaffContext(h.db, h.first.row.id, { stepUpAt: h.clock.now() });
  let release!: () => void, ready!: (pid: number) => void, rejectReady!: (error: unknown) => void;
  const unlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<number>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  const holder = createTxRunner({ prisma: h.db, appEnv: "test" })
    .run(async (tx) => {
      const [one] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await lockRows(tx, "file_object", [pdf.row.id, competingPdf.row.id]);
      ready(one!.pid);
      await unlocked;
    })
    .catch((error: unknown) => {
      rejectReady(error);
      throw error;
    });
  void holder.catch(() => undefined);
  const pid = await locked;
  let issueKey = uuidv7(),
    replayInput = issueInput;
  const racing = Promise.allSettled([
    invoices.issue(h.first.ctx, h.first.staff, again.invoiceRequestId, issueInput, {
      idem: idem(h.first.ctx, "admin.invoiceRequest.issue", issueInput, issueKey),
    }),
    invoices.issue(h.first.ctx, h.first.staff, competingRequest.invoiceRequestId, competingInput),
  ]);
  try {
    const deadline = performance.now() + 1_000;
    let waiters = 0;
    while (performance.now() < deadline) {
      const blocked = await h.root.tx.run(
        (tx) => tx.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND ${pid}::integer = ANY(pg_blocking_pids(pid))`,
      );
      waiters = blocked.length;
      if (waiters === 2) break;
      await delay(10);
    }
    // Both calls passed numberAvailable before their distinct file locks blocked.
    expect(waiters).toBe(2);
  } finally {
    release();
    await holder;
    await racing;
  }
  const outcomes = await racing;
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const loserIndex = outcomes.findIndex((result) => result.status === "rejected"),
    loser = outcomes[loserIndex]!;
  if (loser.status !== "rejected") throw new Error("同票号竞争必须存在一个失败者");
  expect(loser.reason).toMatchObject({ error: "INVOICE_NO_TAKEN" });
  const loserRequest = [again, competingRequest][loserIndex]!,
    loserFile = [pdf, competingPdf][loserIndex]!;
  expect(
    (await h.db.invoiceRequest.findUniqueOrThrow({ where: { id: loserRequest.invoiceRequestId } }))
      .status,
  ).toBe("pending");
  expect(
    await h.db.invoiceDoc.count({ where: { invoiceRequestId: loserRequest.invoiceRequestId } }),
  ).toBe(0);
  expect(
    await h.db.fileRef.count({ where: { fileId: loserFile.row.id, refType: "invoice_doc" } }),
  ).toBe(0);
  expect(
    await h.db.statusTransition.count({
      where: { subjectId: loserRequest.invoiceRequestId, event: "invoice.issue" },
    }),
  ).toBe(0);
  expect(
    await h.db.auditLog.count({
      where: { targetId: loserRequest.invoiceRequestId, action: "billing.invoice.issue" },
    }),
  ).toBe(0);
  h.clock.set(new Date("2040-03-31T16:00:00Z"));
  let detail: Awaited<ReturnType<typeof invoices.issue>>;
  const firstOutcome = outcomes[0]!;
  if (firstOutcome.status === "fulfilled") {
    detail = firstOutcome.value;
    await invoices.issue(h.first.ctx, h.first.staff, competingRequest.invoiceRequestId, {
      ...competingInput,
      invoiceNo: "20400000000000000003",
    });
  } else {
    issueKey = uuidv7();
    replayInput = { ...issueInput, invoiceNo: "20400000000000000003" };
    detail = await invoices.issue(h.first.ctx, h.first.staff, again.invoiceRequestId, replayInput, {
      idem: idem(h.first.ctx, "admin.invoiceRequest.issue", replayInput, issueKey),
    });
  }
  const winnerRequest = [again, competingRequest][1 - loserIndex]!;
  h.clock.set(new Date("2040-03-31T15:59:59Z"));
  expect((await invoices.adminSummary(h.first.staff, {})).issuedThisMonth).toEqual({
    amountFen: String(winnerRequest.amountFen),
    count: 1,
  });
  h.clock.set(new Date("2040-03-31T16:00:00Z"));
  expect((await invoices.adminSummary(h.first.staff, {})).issuedThisMonth).toEqual({
    amountFen: String(loserRequest.amountFen),
    count: 1,
  });
  expect(detail).toMatchObject({
    status: "issued",
    docs: [expect.objectContaining({ docKind: "blue", emailState: "queued", hasFile: true })],
  });
  const issuedBefore = await snapshotTables(h.db, tables);
  await invoices.issue(h.first.ctx, h.first.staff, again.invoiceRequestId, replayInput, {
    idem: idem(h.first.ctx, "admin.invoiceRequest.issue", replayInput, issueKey),
  });
  expect(await snapshotTables(h.db, tables)).toEqual(issuedBefore);
  const blue = await h.db.invoiceDoc.findFirstOrThrow({
    where: { invoiceRequestId: again.invoiceRequestId, docKind: "blue" },
  });
  expect(
    await h.db.fileRef.count({
      where: {
        fileId: pdf.row.id,
        refType: "invoice_doc",
        refId: blue.id,
        role: "main",
        state: "live",
      },
    }),
  ).toBe(1);
  const actual = h.actualWorker(),
    sent = await h.notify(blue.id, actual);
  expect(sent.delivery).toMatchObject({ status: "skipped", reason: "unconfigured" });
  expect((await h.db.invoiceDoc.findUniqueOrThrow({ where: { id: blue.id } })).emailState).toBe(
    "skipped",
  );
  expect(h.providers.mail.outbox).toHaveLength(0);
  const download = await invoices.download(target.own.actor, again.invoiceRequestId, "blue");
  expect(h.providers.storage.fetch(download.url)).toMatchObject({ status: 200, body: pdf.bytes });
  await expect(
    invoices.download(other.actor, again.invoiceRequestId, "blue"),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect((await invoices.summary(target.own.actor, {})).byStatus).toMatchObject({
    issued: 1,
    rejected: 1,
  });
  expect(
    (await invoices.adminList(h.first.staff, { tab: "processed", page: 1, pageSize: 20 })).total,
  ).toBe(3);
}, 30_000);

it("真实worker邮件失败后重发受理：一份附件、最新delivery绑定，迟到失败不能覆盖sent或泄露正文", async () => {
  const h = await fixture(),
    target = await h.paid(),
    request = await h.request(target),
    pdf = await h.file(target.own.entity.id, "invoice");
  const detail = await h.issue(request, pdf.row.id),
    blue = detail.docs[0]!;
  const actual = h.actualWorker();
  h.providers.mail.failNotificationNext(
    "send",
    { acceptance: "not_accepted", code: "provider_rejected" },
    { reason: "rejected", message: "固定拒绝" },
  );
  const failed = await h.notify(blue.invoiceDocId, actual);
  expect(failed.delivery).toMatchObject({
    status: "failed",
    reason: "provider_rejected",
    attemptNo: 1,
  });
  expect(
    (await h.db.invoiceDoc.findUniqueOrThrow({ where: { id: blue.invoiceDocId } })).emailState,
  ).toBe("failed");
  await h.db.notifyScene.update({
    where: { sceneKey: "m.invoice_issued" },
    data: { extEnabled: false },
  });
  const disabled = await snapshotTables(h.db, [
    "invoice_doc",
    "notification_delivery",
    "outbox_event",
  ]);
  await expect(
    h.root.billing.invoices.resend(h.first.ctx, h.first.staff, request.invoiceRequestId),
  ).rejects.toMatchObject({ error: "NOTIFY_RESEND_NOT_ALLOWED" });
  expect(
    await snapshotTables(h.db, ["invoice_doc", "notification_delivery", "outbox_event"]),
  ).toEqual(disabled);
  await h.db.notifyScene.update({
    where: { sceneKey: "m.invoice_issued" },
    data: { extEnabled: true },
  });
  await h.root.billing.invoices.resend(h.first.ctx, h.first.staff, request.invoiceRequestId);
  const latest = await h.db.notificationDelivery.findFirstOrThrow({
    where: { channel: "mail", notificationId: failed.delivery.notificationId },
    orderBy: { resendNo: "desc" },
  });
  expect(latest).toMatchObject({ status: "pending", resendNo: 1 });
  expect(latest.id).not.toBe(failed.delivery.id);
  await actual.notifyDeliver({ deliveryId: latest.id });
  const accepted = await h.db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: latest.id, eventType: "notify.mail_delivered" },
  });
  await h.deliver("billing.onMailResult", accepted.id, actual.assembly);
  const sent = await h.db.invoiceDoc.findUniqueOrThrow({ where: { id: blue.invoiceDocId } });
  expect(sent).toMatchObject({ emailState: "sent", emailSentAt: h.clock.now() });
  expect(h.providers.mail.outbox).toHaveLength(1);
  expect(h.providers.mail.outbox[0]).toMatchObject({
    to: email,
    attachments: [expect.objectContaining({ content: pdf.bytes, contentType: "application/pdf" })],
  });
  const noMore = await snapshotTables(h.db, [
    "invoice_doc",
    "notification_delivery",
    "outbox_event",
  ]);
  await actual.notifyDeliver({ deliveryId: latest.id });
  await h.deliver("billing.onMailResult", failed.result.id, actual.assembly);
  expect(
    await snapshotTables(h.db, ["invoice_doc", "notification_delivery", "outbox_event"]),
  ).toEqual(noMore);
  expect(h.providers.mail.outbox).toHaveLength(1);
  const notification = await h.db.notification.findUniqueOrThrow({
    where: { id: latest.notificationId! },
  });
  const exposed = JSON.stringify(
    {
      vars: notification.vars,
      events: await h.db.outboxEvent.findMany({
        where: {
          eventType: { in: ["invoice.issued", "notify.mail_delivered", "notify.mail_failed"] },
        },
      }),
    },
    (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  expect(exposed).not.toContain(email);
  expect(exposed).not.toContain(Buffer.from(pdf.bytes).toString("base64"));
}, 30_000);

it("真实worker开票SLA到期与结束取消；仅批准当前入账退款触发红冲，红票负数关联原蓝票", async () => {
  // Timer claims use database time. A past business clock makes the real deadline
  // due without changing timer rows or pretending that PostgreSQL time advanced.
  const [databaseNow] = await (await handle.prisma()).$queryRaw<{ now: Date }[]>`SELECT now()`;
  const h = await fixture(true, new Date(databaseNow!.now.getTime() - 2 * 3_600_000)),
    target = await h.paid();
  await h.db.paramValue.create({
    data: {
      id: uuidv7(),
      key: "sla.review.invoice_request",
      value: { amount: 1, unit: "natural_hours" },
      effectiveAt: h.clock.now(),
      createdByStaffId: h.creator.row.id,
      createdAt: h.clock.now(),
    },
  });
  const cancelled = await h.request(target);
  const cancelledTimer = await h.db.timer.findFirstOrThrow({
    where: { kind: "sla.breach", subjectId: cancelled.invoiceRequestId, status: "scheduled" },
  });
  const reason = await h.db.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "invoice" },
    },
  });
  await h.root.billing.invoices.reject(h.first.ctx, h.first.staff, cancelled.invoiceRequestId, {
    reasonCode: reason.code,
    note: "本轮取消开票计时后重提",
  });
  expect((await h.db.timer.findUniqueOrThrow({ where: { id: cancelledTimer.id } })).status).toBe(
    "cancelled",
  );
  const request = await h.request(target),
    actual = h.actualWorker();
  const timer = await h.db.timer.findFirstOrThrow({
    where: {
      kind: "sla.breach",
      subjectType: "invoice_request",
      subjectId: request.invoiceRequestId,
      status: "scheduled",
    },
  });
  h.clock.set(timer.fireAt);
  const due = await h.root.tx.run((tx) => claimTimers(tx, actual.timers.registry, h.clock.now()));
  const ref = due.claimed.find((value) => value.timerId === timer.id);
  expect(ref).toBeDefined();
  expect(await actual.runTimer(ref!)).toBe("fired");
  expect(
    await h.db.outboxEvent.count({
      where: { eventType: "invoice.sla_breached", aggregateId: request.invoiceRequestId },
    }),
  ).toBe(1);
  expect(await actual.runTimer(ref!)).toBe("stale");
  h.first.staff = await sampleStaffContext(h.db, h.first.row.id, { stepUpAt: h.clock.now() });
  const pdf = await h.file(target.own.entity.id, "invoice");
  const issued = await h.issue(request, pdf.row.id),
    blue = issued.docs[0]!;
  expect(
    await h.db.timer.count({
      where: {
        kind: "sla.breach",
        subjectId: request.invoiceRequestId,
        status: { in: ["scheduled", "dispatched"] },
      },
    }),
  ).toBe(0);
  const refundId = uuidv7(),
    approvalId = uuidv7(),
    now = h.clock.now();
  // W4-10 is not implemented: only its valid initial approved-request fixture is created here.
  // The invoice state itself changes exclusively through its registered public flow.
  const approvalData = {
    id: approvalId,
    requestNo: `TK${approvalId.replaceAll("-", "")}`,
    kind: "plan_refund",
    category: "approval",
    subjectType: "billing_order",
    subjectId: target.current.id,
    entityId: target.own.entity.id,
    status: "approved",
    summarySnapshot: { title: "本轮退款批准事实" },
    submitActorType: "staff",
    submitActorId: h.creator.row.id,
    submitClient: "admin",
    requesterStaffId: h.creator.row.id,
    submittedAt: now,
    decidedByStaffId: h.second.row.id,
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const refundDue = await h.root.tx.run(async (tx) =>
    createSla({ clock: h.clock, assembly: h.root.assembly }).dueAt(tx, {
      policy: "review.refund_execute",
      amount: 1,
      unit: "natural_hours",
      from: now,
      workHours: await workHoursAt(tx, now),
    }),
  );
  const refundData = {
    id: refundId,
    approvalRequestId: approvalId,
    source: "customer_service",
    entityId: target.own.entity.id,
    billingOrderId: target.current.id,
    paymentTxnId: target.current.paidPaymentTxnId!,
    baseAmountFen: target.current.paidAmountFen,
    amountFen: target.current.paidAmountFen,
    breakdownSnapshot: {},
    ruleCode: "window",
    ruleText: "本轮已批准全额退入账夹具",
    reasonCode: "other",
    status: "pending_execution",
    execDueAt: refundDue.dueAt,
    slaSnapshot: { ...refundDue.snapshot },
    createdAt: now,
    updatedAt: now,
  };
  const system = createIdentityContext({
    actor: { type: "system", job: "billing.refund_test" },
    entityId: target.own.entity.id,
  });
  const otherEntity = (await h.merchant()).entity.id;
  const malformed = [
    {
      kind: "finance_config_change",
      subjectType: "finance_config_revision",
      subjectId: uuidv7(),
      entityId: null,
      requestNo: null,
      dedupeKey: `finance_config_change:${uuidv7()}`,
    },
    {
      kind: "plan_refund",
      subjectType: "payment_txn",
      subjectId: target.current.paidPaymentTxnId!,
      entityId: target.own.entity.id,
      dedupeKey: null,
    },
    {
      kind: "plan_refund",
      subjectType: "billing_order",
      subjectId: target.current.id,
      entityId: otherEntity,
      dedupeKey: null,
    },
  ];
  const invalidBefore = await snapshotTables(h.db, [
    "invoice_request",
    "invoice_doc",
    "status_transition",
    "audit_log",
    "outbox_event",
    "refund_request",
    "approval_request",
  ]);
  for (const mismatch of malformed) {
    const rollback = new Error("本轮无效审批关系夹具回滚");
    await h.root.tx
      .run(async (tx) => {
        const badApprovalId = uuidv7(),
          badRefundId = uuidv7();
        await tx.approvalRequest.create({
          data: { ...approvalData, id: badApprovalId, ...mismatch },
        });
        await tx.refundRequest.create({
          data: { ...refundData, id: badRefundId, approvalRequestId: badApprovalId },
        });
        const before = await snapshotTables(tx, [
          "invoice_request",
          "invoice_doc",
          "status_transition",
          "audit_log",
          "outbox_event",
        ]);
        await expect(
          markInvoiceRedPending(tx, { flow: h.root.flow }, system, {
            refundRequestId: badRefundId,
          }),
        ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
        expect(
          await snapshotTables(tx, [
            "invoice_request",
            "invoice_doc",
            "status_transition",
            "audit_log",
            "outbox_event",
          ]),
        ).toEqual(before);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
  }
  expect(
    await snapshotTables(h.db, [
      "invoice_request",
      "invoice_doc",
      "status_transition",
      "audit_log",
      "outbox_event",
      "refund_request",
      "approval_request",
    ]),
  ).toEqual(invalidBefore);
  await h.db.approvalRequest.create({ data: approvalData });
  await h.db.refundRequest.create({ data: refundData });
  await expect(
    h.root.tx.run((tx) =>
      markInvoiceRedPending(tx, { flow: h.root.flow }, h.first.ctx, { refundRequestId: refundId }),
    ),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await h.root.tx.run((tx) => readInvoiceRefundGuard(tx, target.current.id))).toMatchObject({
    needsRedInvoice: true,
    latest: { status: "issued" },
  });
  await h.root.tx.run((tx) =>
    markInvoiceRedPending(tx, { flow: h.root.flow }, system, { refundRequestId: refundId }),
  );
  expect((await h.root.billing.invoices.get(h.first.staff, request.invoiceRequestId)).status).toBe(
    "red_pending",
  );
  // Guard-only evidence for W4-10 inputs: no refund execution port exists yet.
  // These read projections never persist a refunded order or a closed request.
  const realRefund = await h.db.refundRequest.findUniqueOrThrow({ where: { id: refundId } });
  const redPendingBefore = await snapshotTables(h.db, [
    "invoice_request",
    "billing_order",
    "payment_txn",
    "refund_request",
    "refund_txn",
    "audit_log",
    "outbox_event",
  ]);
  const transition = vi.fn(h.root.flow.transition);
  await h.root.tx.run(async (tx) => {
    const restore: Array<() => void> = [];
    try {
      const closed = vi.spyOn(tx.refundRequest, "findUnique").mockResolvedValue({
        ...realRefund,
        status: "not_executed",
        closedAt: now,
        closeReason: "voided",
        voidedByStaffId: h.first.row.id,
        closeNote: "本轮局部守卫事实",
      });
      restore.push(() => closed.mockRestore());
      // The same projected closed request is no longer active.
      const active = vi.spyOn(tx.refundRequest, "count").mockResolvedValue(0);
      restore.push(() => active.mockRestore());
      const refunded = vi.spyOn(tx.billingOrder, "findUniqueOrThrow").mockResolvedValue({
        ...target.current,
        status: "refunded",
        refundedAt: now,
        refundedAmountFen: target.current.paidAmountFen,
      });
      restore.push(() => refunded.mockRestore());
      // Keep the actual tx.run handle: lockRows must still validate and lock it.
      await cancelInvoiceRed(tx, { flow: { transition } }, system, { refundRequestId: refundId });
      for (const [input] of active.mock.calls)
        expect(input).toMatchObject({
          where: {
            billingOrderId: target.current.id,
            paymentTxnId: target.current.paidPaymentTxnId,
            status: { in: ["pending_execution", "executing"] },
          },
        });
    } finally {
      for (const undo of restore.reverse()) undo();
    }
  });
  expect(transition).not.toHaveBeenCalled();
  expect(
    (await h.db.invoiceRequest.findUniqueOrThrow({ where: { id: request.invoiceRequestId } }))
      .status,
  ).toBe("red_pending");
  expect(
    await snapshotTables(h.db, [
      "invoice_request",
      "billing_order",
      "payment_txn",
      "refund_request",
      "refund_txn",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(redPendingBefore);
  const redFile = await h.file(target.own.entity.id, "invoice"),
    body = {
      invoiceNo: "20400000000000000002",
      fileId: redFile.row.id,
      redReason: "本轮批准退款红冲",
      confirm: {
        requestNo: request.requestNo,
        blueInvoiceNo: blue.invoiceNo,
        amountFen: request.amountFen,
      },
    };
  const red = await h.root.billing.invoices.issueRed(
    h.first.ctx,
    h.first.staff,
    request.invoiceRequestId,
    body,
  );
  expect(red.status).toBe("red_issued");
  const stored = await h.db.invoiceDoc.findFirstOrThrow({
    where: { invoiceRequestId: request.invoiceRequestId, docKind: "red" },
  });
  expect(stored).toMatchObject({
    amountFen: -target.current.paidAmountFen,
    originalInvoiceDocId: blue.invoiceDocId,
    emailState: "none",
  });
  expect(await h.root.tx.run((tx) => readInvoiceRefundGuard(tx, target.current.id))).toMatchObject({
    needsRedInvoice: false,
    latest: { status: "red_issued" },
  });
  expect(
    h.providers.storage.fetch(
      (await h.root.billing.invoices.download(target.own.actor, request.invoiceRequestId, "red"))
        .url,
    ),
  ).toMatchObject({ status: 200, body: redFile.bytes });
  expect(await h.db.refundTxn.count({ where: { billingOrderId: target.current.id } })).toBe(0);
}, 30_000);
