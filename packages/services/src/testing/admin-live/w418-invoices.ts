import { planOrderContentSchema, z } from "@liyoxi/contract";
import { createIdentityContext, createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { placeholderPdf } from "../../media/index.js";
import { sampleStaffContext } from "../approval.js";
import type { FakeProviders } from "../providers/index.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixtureContext } from "./context.js";

/** 本域三个小样本：仅工厂准备pending单/资料，收款、开票、退款批准与邮件失败均走真实公口。 */
export async function prepareW418Invoices({ runtime, make }: AdminLiveFixtureContext) {
  const live = assertDeliveryLiveEnvironment(runtime.env),
    { runId } = live;
  if (runtime.providers.storage.status !== "fake" || runtime.providers.mail.status !== "fake")
    throw new Error("W418发票只接受本轮假存储与假邮件");
  const providers = runtime.providers as FakeProviders,
    now = runtime.clock.now();
  const setup = await runtime.tx.run(async (tx) => {
    const admin = await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    });
    const plan = await tx.plan.findFirstOrThrow({
      where: { isListed: true },
      orderBy: { rank: "asc" },
    });
    const bank = await tx.financeConfigRevision.findFirstOrThrow({
      where: {
        configKey: "bank_account",
        effectiveAt: { lte: now },
        approvalRequest: { status: "approved" },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    });
    const reason = await tx.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "reject_reason", code: "IV418" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "reject_reason",
        code: "IV418",
        name: "发票资料核对不符",
        ext: { scene: "invoice" },
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
    const refundReason = await tx.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "refund_reason", code: "IVRF418" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "refund_reason",
        code: "IVRF418",
        name: "本轮红冲演练",
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
    for (const type of ["plan_new", "plan_renew", "plan_upgrade", "topup"])
      await tx.paramValue.create({
        data: {
          id: uuidv7(),
          key: `invoice.item_name.${type}`,
          value: "本轮虚构发票服务",
          effectiveAt: now,
          createdByStaffId: admin.id,
          createdAt: now,
        },
      });
    await tx.notifyScene.upsert({
      where: { sceneKey: "m.invoice_issued" },
      create: {
        sceneKey: "m.invoice_issued",
        audience: "merchant",
        name: "本轮开票通知",
        sceneEnabled: true,
        extEnabled: true,
        sendWindow: "immediate",
        createdAt: now,
        updatedAt: now,
      },
      update: { sceneEnabled: true, extEnabled: true, sendWindow: "immediate", updatedAt: now },
    });
    return { admin, plan, bank, reason, refundReason };
  });
  const staff = await runtime.tx.run((tx) =>
      sampleStaffContext(tx, setup.admin.id, { stepUpAt: now }),
    ),
    ctx = createIdentityContext({ actor: { type: "staff", id: setup.admin.id, client: "admin" } }),
    reviewer = await make.staff({ name: "W418红冲关联退款复核人", staffRoleKey: "super_admin" }),
    reviewerStaff = await runtime.tx.run((tx) =>
      sampleStaffContext(tx, reviewer.id, { stepUpAt: now }),
    ),
    reviewerCtx = createIdentityContext({
      actor: { type: "staff", id: reviewer.id, client: "admin" },
    });
  const options = (identity: IdentityContext, scope: string, body: unknown) => ({
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      actor: identity.actor,
      key: `iv418:${uuidv7()}`,
      request: { method: "POST", body },
    }),
  });
  const requests = [];
  for (let index = 0; index < 3; index++) {
    const own = await make.merchant({ verified: true });
    const entityName = `W418发票${runId.slice(0, 6)}主体${index + 1}`;
    await runtime.tx.run((tx) =>
      tx.entity.update({ where: { id: own.entity.id }, data: { name: entityName } }),
    );
    const actor = {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
          entityId: own.entity.id,
          storeId: own.store.id,
        }),
        membership: {
          memberId: own.owner.id,
          entityId: own.entity.id,
          storeId: own.store.id,
          role: "owner" as const,
          storeMode: "active" as const,
        },
      },
      client = { platform: "devtools", appVersion: "1.0.0" },
      quote = await runtime.billing.quotePlanPurchase(actor, client, {
        planId: setup.plan.id,
        months: 1,
      });
    const order = await make.billingOrder({
      entityId: own.entity.id,
      storeId: own.store.id,
      status: "pending_payment",
      channel: "bank_transfer",
      transferState: "awaiting_proof",
      bankAccountFinanceConfigRevisionId: setup.bank.id,
      amountFen: quote.payFen,
      contentSnapshot: planOrderContentSchema.parse({
        v: 1,
        kind: "plan",
        planId: quote.planId,
        planName: quote.planName,
        planRevisionId: quote.planRevisionId,
        months: quote.months,
        cyclePriceFen: quote.payFen,
        payFen: quote.payFen,
        monthlyPoints: quote.benefits.monthlyPoints,
        discountBp: quote.benefits.discountBp,
        promo: null,
        quotedAt: quote.quotedAt,
      }),
      fulfillmentStatus: "none",
      expiresAt: new Date(now.getTime() + 86400000),
    });
    const receipt = await make.fileObject({
      category: "pay_receipt",
      bucket: "secure",
      scopeType: "entity",
      entityId: own.entity.id,
      storeId: null,
      uploadActorType: "merchant",
      uploadActorId: own.user.id,
      uploadClient: "weapp",
      ext: "png",
      declaredMime: "image/png",
      mime: "image/png",
    });
    const submitted = await runtime.billing.submitProof(actor, client, order.id, receipt.id);
    if (!submitted.latestTransferProof) throw new Error("本轮发票缺少真实收款凭证");
    const proof = await runtime.billing.getProof(
        staff,
        submitted.latestTransferProof.transferProofId,
      ),
      body = {
        lockVersion: proof.lockVersion,
        bankSerialNo: `IV418-${runId}-${index}`,
        confirm: { orderNo: order.orderNo, receivedAmountFen: quote.payFen },
        confirmChecks: ["bank_statement_checked"],
      };
    const paid = await runtime.billing.confirmProof(
      ctx,
      staff,
      proof.transferProofId,
      body,
      options(ctx, "admin.transferProof.confirm", body),
    );
    if (paid.outcome !== "paid") throw new Error("本轮发票必须由真实收款完成");
    const request = await runtime.billing.invoices.create(actor, {
      paymentOrderId: order.id,
      invoiceType: "normal",
      medium: "electronic",
      recvEmail: "fictional-invoice@example.invalid",
    });
    requests.push({ request, entityName, order });
  }
  const pending = requests[0]!,
    rejected = requests[1]!,
    red = requests[2]!,
    bytes = placeholderPdf("W418-FICTIONAL-INVOICE");
  const actor = { identity: ctx, staff };
  const file = (
    await runtime.media.register(actor, {
      category: "invoice",
      entityId: red.order.entityId,
      files: [
        {
          fileName: "fictional-blue.pdf",
          sizeBytes: String(bytes.byteLength),
          clientToken: uuidv7(),
        },
      ],
    })
  ).items[0]!;
  providers.storage.put({ bucket: "secure", key: file.key }, bytes, "application/pdf");
  await runtime.media.complete(actor, file.fileId);
  const job = await runtime.tx.run((tx) =>
    tx.mediaJob.findFirstOrThrow({
      where: { kind: "promote", subjectType: "file_object", subjectId: file.fileId },
    }),
  );
  await runtime.media.jobs.run({ jobId: job.id });
  const blue = await runtime.billing.invoices.issue(ctx, staff, red.request.invoiceRequestId, {
    invoiceNo: "20400000000000004180",
    fileId: file.fileId,
    confirm: { requestNo: red.request.requestNo, amountFen: red.request.amountFen },
  });
  const doc = blue.docs.find((value) => value.docKind === "blue");
  if (!doc) throw new Error("本轮红冲缺蓝票");
  const deliver = async (
    name: string,
    event: { id: string; eventType: string; payload: unknown },
  ) => {
    const subscriber = runtime.assembly.subscriber(name);
    if (!subscriber) throw new Error("本轮发票缺实际订阅者");
    await runtime.tx.run((tx) =>
      subscriber.handle(tx, {
        id: event.id,
        type: event.eventType,
        payload: z.record(z.string(), z.unknown()).parse(event.payload),
      }),
    );
  };
  const issued = await runtime.tx.run((tx) =>
    tx.outboxEvent.findFirstOrThrow({
      where: { eventType: "invoice.issued", aggregateId: doc.invoiceDocId },
    }),
  );
  await deliver("notify.onEvent", issued);
  const delivery = await runtime.tx.run((tx) =>
    tx.notificationDelivery.findFirstOrThrow({
      where: { channel: "mail", notification: { bizType: "invoice_doc", bizId: doc.invoiceDocId } },
      orderBy: { resendNo: "desc" },
    }),
  );
  providers.mail.failNotificationNext(
    "send",
    { acceptance: "not_accepted", code: "provider_rejected" },
    { reason: "rejected", message: "本轮假邮件明确未受理" },
  );
  await runtime.notify.deliver({ deliveryId: delivery.id });
  const failed = await runtime.tx.run((tx) =>
    tx.outboxEvent.findFirstOrThrow({
      where: { aggregateId: delivery.id, eventType: "notify.mail_failed" },
      orderBy: { createdAt: "desc" },
    }),
  );
  await deliver("billing.onMailResult", failed);
  const quote = await runtime.billing.refunds.quote(staff, red.order.id, "window");
  if (!quote.supported || !quote.rules.some((rule) => rule.rule === "window" && rule.eligible))
    throw new Error("本轮真实红冲退款不可用");
  const refundBody = {
      ruleCode: "window" as const,
      reasonCode: setup.refundReason.code,
      note: "仅本轮红字回填演练",
      confirm: { orderNo: red.order.orderNo, amountFen: quote.refundableFen },
    },
    refund = await runtime.billing.refunds.create(
      ctx,
      staff,
      red.order.id,
      refundBody,
      options(ctx, "admin.paymentOrder.refundRequest.create", refundBody),
    ),
    approval = {
      lockVersion: refund.approval.lockVersion,
      confirm: { requestNo: refund.requestNo, amountFen: refund.amountFen },
      confirmChecks: ["rule_amount_checked"],
    };
  await runtime.billing.refunds.approve(
    reviewerCtx,
    reviewerStaff,
    refund.refundRequestId,
    approval,
    options(reviewerCtx, "admin.refundRequest.approve", approval),
  );
  const current = await runtime.billing.invoices.get(staff, red.request.invoiceRequestId);
  if (
    current.status !== "red_pending" ||
    !current.actions.includes("resend") ||
    current.docs[0]?.emailState !== "failed"
  )
    throw new Error("本轮红冲/邮件失败必须来自真实处理结果");
  return {
    scope: {
      ...live,
      startedAt: now.toISOString(),
      staffId: setup.admin.id,
      entityIds: requests.map((value) => value.order.entityId),
    },
    pending: { id: pending.request.invoiceRequestId, requestNo: pending.request.requestNo },
    reject: { id: rejected.request.invoiceRequestId, requestNo: rejected.request.requestNo },
    red: { id: red.request.invoiceRequestId, requestNo: red.request.requestNo },
    pdf: Buffer.from(bytes).toString("base64"),
    rejectReason: setup.reason.name,
    requesterStaffId: setup.admin.id,
    reviewerStaffId: reviewer.id,
  };
}
