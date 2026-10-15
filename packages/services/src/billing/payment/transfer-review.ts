// W4-04：同一凭证的一次人工确认；小额与二人复核共用唯一收款入账函数。
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@liyoxi/db";
import type { BillingOrder, TransferProof } from "@liyoxi/db";
import { TransferProofApproveReviewBodySchema } from "@liyoxi/contract";
import type {
  TransferProofConfirmBody,
  TransferProofApproveReviewBody,
  TransferProofRejectReviewBody,
} from "@liyoxi/contract";
import { AppError, lockRows, uuidv7, createIdentityContext } from "../../kernel/index.js";
import type { Tx, IdentityContext, Assembly, KeyedPort } from "../../kernel/index.js";
import { assertPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { defineApprovalKind, approvalKindPort } from "../../approval/index.js";
import type { Approval, ApprovalRow } from "../../approval/index.js";
import { dictRef, proofInScope, proofDetailView, orderInScope } from "./purchase-read.js";
import type { BillingPurchaseDeps } from "./purchase-context.js";
import { cancelTransferSla, handleTransferSla } from "./transfer-sla.js";
import { onTransferCalendarImported } from "./calendar.js";

export const normalizeBankSerial = (raw: string) =>
  raw.normalize("NFKC").replace(/[\s-]/gu, "").toUpperCase();
const firstConfirmSchema = z
  .strictObject({
    bankSerialRaw: z.string().min(1).max(64),
    bankSerialNorm: z.string().min(1),
    payerBank: z.string().nullable(),
    receivedAmountFen: z.int().positive(),
  })
  .refine((v) => v.bankSerialNorm === normalizeBankSerial(v.bankSerialRaw));
export function readFirstConfirm(value: unknown) {
  const parsed = firstConfirmSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export async function serialConflicts(tx: Tx, serial: string, excludeId?: string) {
  return tx.paymentTxn.findMany({
    where: {
      channel: "bank_transfer",
      channelTxnNo: serial,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    include: { billingOrder: { select: { orderNo: true } } },
  });
}
export async function checkBankSerial(
  tx: Tx,
  serial: string,
  input: TransferProofConfirmBody,
  excludeId?: string,
  review = false,
) {
  if (!serial) throw new AppError("VALIDATION_FAILED");
  if (
    input.payerBankCode &&
    !(await tx.dictItem.findFirst({
      where: { dictTypeKey: "bank", code: input.payerBankCode, isEnabled: true },
    }))
  )
    throw new AppError("DICT_ITEM_DISABLED");
  const conflicts = await serialConflicts(tx, serial, excludeId);
  if (
    conflicts.length &&
    (!input.payerBankCode || conflicts.some((c) => c.payerBank === input.payerBankCode))
  )
    throw new AppError("BANK_SERIAL_DUPLICATE", {
      details: {
        conflicts: await Promise.all(
          conflicts.map(async (c) => ({
            ref: c.billingOrder?.orderNo ?? c.outTradeNo,
            payerBank: await dictRef(tx, "bank", c.payerBank),
          })),
        ),
      },
    });
  const expected = conflicts.map((c) => c.billingOrder?.orderNo ?? c.outTradeNo).sort();
  const actual = [...new Set(input.confirm.conflictOrderNos ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new AppError(review ? "BANK_SERIAL_DUPLICATE" : "CONFIRM_MISMATCH");
}
export async function lockBankSerial(tx: Tx, serial: string) {
  // 沿用唯一人工确认咨询锁，不增加新的锁名/锁序机制。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lyx:billing:transfer-confirm:bank_transfer:${serial}`}, 0))`;
}
interface AcceptInput {
  proof: TransferProof;
  input: TransferProofConfirmBody;
  confirmedByStaffId: string;
  reviewedByStaffId?: string;
  reviewApprovalId?: string;
}
export async function acceptTransferProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  arg: AcceptInput,
) {
  const { proof: before, input } = arg;
  await lockRows(tx, "billing_order", [before.billingOrderId]);
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: before.billingOrderId } });
  const serial = normalizeBankSerial(input.bankSerialNo);
  await lockBankSerial(tx, serial);
  await checkBankSerial(tx, serial, input);
  if (
    order.createdByStaffId === arg.confirmedByStaffId ||
    order.createdByStaffId === arg.reviewedByStaffId
  )
    throw new AppError("CONFIRMER_IS_ORDER_CREATOR");
  if (order.orderNo !== input.confirm.orderNo) throw new AppError("CONFIRM_MISMATCH");
  if (order.amountFen !== input.confirm.receivedAmountFen)
    throw new AppError("TRANSFER_AMOUNT_MISMATCH");
  if (
    order.status !== "pending_confirmation" ||
    order.channel !== "bank_transfer" ||
    order.transferState !== (arg.reviewApprovalId ? "confirm_review" : "proof_submitted")
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now();
  const latest = await tx.paymentTxn.aggregate({
    where: { billingOrderId: order.id },
    _max: { attemptNo: true },
  });
  const attemptNo = (latest._max.attemptNo ?? 0) + 1,
    txnId = uuidv7();
  await tx.paymentTxn.create({
    data: {
      id: txnId,
      entityId: order.entityId,
      billingOrderId: order.id,
      channel: "bank_transfer",
      attemptNo,
      outTradeNo: `${order.orderNo}-${String(attemptNo).padStart(2, "0")}-${randomBytes(3).toString("hex").toUpperCase()}`,
      amountFen: order.amountFen,
      channelAmountFen: input.confirm.receivedAmountFen,
      channelPayerRef: (
        await tx.entity.findUniqueOrThrow({ where: { id: order.entityId }, select: { name: true } })
      ).name,
      status: "succeeded",
      channelTxnNo: serial,
      bankSerialRaw: input.bankSerialNo,
      payerBank: input.payerBankCode ?? null,
      channelSuccessAt: now,
      transferProofId: before.id,
      confirmedByStaffId: arg.confirmedByStaffId,
      reviewedByStaffId: arg.reviewedByStaffId ?? null,
      reconState: "matched",
      createdAt: now,
      updatedAt: now,
    },
  });
  await lockRows(tx, "payment_txn", [txnId]);
  await lockRows(tx, "transfer_proof", [before.id]);
  const proof = await tx.transferProof.findUniqueOrThrow({ where: { id: before.id } });
  if (proof.lockVersion !== before.lockVersion) throw new AppError("VERSION_CONFLICT");
  if (
    proof.reviewStatus !== "pending" ||
    proof.reviewApprovalRequestId !== before.reviewApprovalRequestId ||
    (arg.reviewApprovalId !== undefined &&
      (proof.reviewApprovalRequestId !== arg.reviewApprovalId ||
        !readFirstConfirm(proof.firstConfirm)))
  )
    throw new AppError("PRECONDITION_CHANGED");
  await checkBankSerial(tx, serial, input, txnId, arg.reviewApprovalId !== undefined);
  await tx.transferProof.update({
    where: { id: proof.id },
    data: {
      reviewStatus: "accepted",
      firstConfirm: Prisma.DbNull,
      reviewedByStaffId: arg.reviewedByStaffId ?? arg.confirmedByStaffId,
      reviewedAt: now,
      lockVersion: { increment: 1 },
      updatedAt: now,
    },
  });
  await cancelTransferSla(tx, deps.timers, proof.id);
  await deps.payment.applyPayment(tx, {
    paymentTxnId: txnId,
    ctx: { ...ctx, entityId: order.entityId, storeId: order.storeId },
  });
}
export async function beginTransferReview(
  tx: Tx,
  deps: BillingPurchaseDeps,
  approval: Approval,
  ctx: IdentityContext,
  staff: StaffContext,
  proof: TransferProof,
  order: BillingOrder,
  input: TransferProofConfirmBody,
) {
  const firstConfirm = firstConfirmSchema.parse({
    bankSerialRaw: input.bankSerialNo,
    bankSerialNorm: normalizeBankSerial(input.bankSerialNo),
    payerBank: input.payerBankCode ?? null,
    receivedAmountFen: input.confirm.receivedAmountFen,
  });
  const request = await approval.submit(tx, ctx, {
    kind: "transfer_confirm",
    subjectType: "transfer_proof",
    subjectId: proof.id,
    entityId: proof.entityId,
    storeId: order.storeId,
    input: { firstConfirm, conflictOrderNos: input.confirm.conflictOrderNos ?? [] },
  });
  await tx.transferProof.update({
    where: { id: proof.id },
    data: {
      firstConfirm,
      reviewApprovalRequestId: request.approvalId,
      lockVersion: { increment: 1 },
      updatedAt: deps.clock.now(),
    },
  });
  await tx.billingOrder.update({
    where: { id: order.id },
    data: { transferState: "confirm_review", updatedAt: deps.clock.now() },
  });
  // 无payment_txn、账本或履约写入；原凭证处理时限继续运行。
  return {
    ...(await proofDetailView(tx, deps, await proofInScope(tx, staff.scope, proof.id), staff)),
    outcome: "review_pending" as const,
  };
}
function transferKind(current: () => BillingPurchaseDeps) {
  return defineApprovalKind<{
    firstConfirm: z.infer<typeof firstConfirmSchema>;
    conflictOrderNos: string[];
  }>({
    category: "approval",
    domain: { table: "transfer_proof", column: "review_approval_request_id" },
    viewModules: ["finance", "order"],
    decidePermission: "finance.receipt.confirm",
    groupBound: false,
    hasExecution: false,
    numberPrefix: null,
    dedupeKey: (s) => `transfer_confirm:${s.subjectId}`,
    roundNo: async (tx, s) =>
      ((
        await tx.approvalRequest.aggregate({
          where: {
            kind: "transfer_confirm",
            subjectType: "transfer_proof",
            subjectId: s.subjectId,
          },
          _max: { roundNo: true },
        })
      )._max.roundNo ?? 0) + 1,
    operations: {
      get: "admin.transferProof.get",
      approve: "admin.transferProof.approveReview",
      reject: "admin.transferProof.rejectReview",
      withdraw: null,
    },
    validate: async (tx, s) => {
      firstConfirmSchema.parse(s.input.firstConfirm);
      const p = await tx.transferProof.findUnique({ where: { id: s.subjectId } });
      const o = p ? await tx.billingOrder.findUnique({ where: { id: p.billingOrderId } }) : null;
      if (
        !p ||
        !o ||
        p.entityId !== s.entityId ||
        p.reviewStatus !== "pending" ||
        p.firstConfirm !== null ||
        o.status !== "pending_confirmation" ||
        o.transferState !== "proof_submitted"
      )
        throw new AppError("PRECONDITION_CHANGED");
    },
    summarize: async (tx, s) => {
      const p = await tx.transferProof.findUniqueOrThrow({ where: { id: s.subjectId } });
      const o = await tx.billingOrder.findUniqueOrThrow({ where: { id: p.billingOrderId } });
      return {
        title: "对公到账二人复核",
        amountFen: o.amountFen,
        // 保存第一人已回显的跨行冲突集合；复核期间新出现冲突不能被静默放行。
        lines: [
          {
            label: "已核对冲突付款单",
            value: JSON.stringify([...new Set(s.input.conflictOrderNos)].sort()),
          },
        ],
        domain: { type: "transfer_proof", id: p.id },
      };
    },
    revalidate: async (tx, row, args) => {
      const { proof, order } = await lockedReview(tx, row);
      const body = TransferProofApproveReviewBodySchema.parse(args);
      if (body.approvalId !== row.id) throw new AppError("APPROVAL_NOT_PENDING");
      if (
        body.confirm.orderNo !== order.orderNo ||
        body.confirm.receivedAmountFen !== order.amountFen ||
        readFirstConfirm(proof.firstConfirm)?.receivedAmountFen !== order.amountFen
      )
        throw new AppError("CONFIRM_MISMATCH");
    },
    onApproved: async (tx, row, decision) => {
      const deps = current(),
        { proof, order } = await lockedReview(tx, row);
      if (
        !decision.decidedByStaffId ||
        !row.requesterStaffId ||
        decision.decidedByStaffId === row.requesterStaffId
      )
        throw new AppError("APPROVAL_SELF_FORBIDDEN");
      const first = readFirstConfirm(proof.firstConfirm)!;
      const encoded = row.summary.lines?.find((line) => line.label === "已核对冲突付款单")?.value;
      const conflicts = z.array(z.string()).parse(encoded === undefined ? [] : JSON.parse(encoded));
      const body = TransferProofApproveReviewBodySchema.parse(decision.args);
      const ctx = createIdentityContext({
        actor: { type: "staff", id: decision.decidedByStaffId, client: "admin" },
        entityId: proof.entityId,
        storeId: order.storeId,
      });
      await acceptTransferProof(tx, deps, ctx, {
        proof,
        confirmedByStaffId: row.requesterStaffId,
        reviewedByStaffId: decision.decidedByStaffId,
        reviewApprovalId: row.id,
        input: {
          lockVersion: proof.lockVersion,
          bankSerialNo: first.bankSerialRaw,
          ...(first.payerBank === null ? {} : { payerBankCode: first.payerBank }),
          confirm: { ...body.confirm, conflictOrderNos: conflicts },
          confirmChecks: body.confirmChecks,
        },
      });
    },
    onRejected: async (tx, row) => {
      const deps = current(),
        { proof, order } = await lockedReview(tx, row);
      await lockRows(tx, "transfer_proof", [proof.id]);
      await tx.transferProof.update({
        where: { id: proof.id },
        data: {
          firstConfirm: Prisma.DbNull,
          lockVersion: { increment: 1 },
          updatedAt: deps.clock.now(),
        },
      });
      await tx.billingOrder.update({
        where: { id: order.id },
        data: { transferState: "proof_submitted", updatedAt: deps.clock.now() },
      });
    },
    onWithdrawn: async () => {
      throw new AppError("STATE_NOT_ALLOWED");
    },
  });
}
async function lockedReview(tx: Tx, row: ApprovalRow) {
  const first = await tx.transferProof.findUnique({ where: { id: row.subjectId } });
  if (!first) throw new AppError("NOT_FOUND");
  await lockRows(tx, "billing_order", [first.billingOrderId]);
  // 凭证310留到创建收款300之后；付款单290已串行化全部凭证处理写链。
  const proof = await tx.transferProof.findUniqueOrThrow({ where: { id: first.id } });
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
  const latest = await tx.approvalRequest.aggregate({
    where: { kind: "transfer_confirm", subjectType: "transfer_proof", subjectId: proof.id },
    _max: { roundNo: true },
  });
  if (
    row.kind !== "transfer_confirm" ||
    row.roundNo !== latest._max.roundNo ||
    row.subjectType !== "transfer_proof" ||
    proof.entityId !== row.entityId ||
    proof.reviewApprovalRequestId !== row.id ||
    proof.reviewStatus !== "pending" ||
    !readFirstConfirm(proof.firstConfirm) ||
    order.status !== "pending_confirmation" ||
    order.transferState !== "confirm_review"
  )
    throw new AppError("PRECONDITION_CHANGED");
  return { proof, order };
}
export const unboundTransferConfirm = transferKind(() => {
  throw new TypeError("对公复核运行时尚未绑定");
});

/** 每个运行时独有的kind/订阅/SLA分流闭包，不使用进程全局默认实例。 */
export function createTransferReviewAssembly(base: Assembly) {
  let deps: BillingPurchaseDeps | undefined,
    closed = false;
  const current = () => {
    if (closed || !deps) throw new TypeError("对公复核运行时尚未绑定或已关闭");
    return deps;
  };
  const kind = transferKind(current);
  if (
    base.portImplementations.filter(
      (item) => item.port === approvalKindPort && item.key === "transfer_confirm",
    ).length !== 1 ||
    base.subscribers.filter((item) => item.name === "billing.onCalendarImported").length !== 1 ||
    base.timerHandlers.filter((item) => item.kind === "sla.breach").length !== 1
  )
    throw new TypeError("对公复核需要唯一的类型、日历订阅和时限登记");
  const implementations = base.portImplementations.map((item) =>
    item.port === approvalKindPort && item.key === "transfer_confirm"
      ? { ...item, impl: kind }
      : item,
  );
  const subscribers = base.subscribers.map((item) =>
    item.name === "billing.onCalendarImported"
      ? {
          ...item,
          handle: (tx: Tx, event: Parameters<typeof onTransferCalendarImported>[2]) =>
            onTransferCalendarImported(tx, current(), event),
        }
      : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (tx: Tx, timer: Parameters<typeof handleTransferSla>[2]) =>
            timer.subjectType === "transfer_proof"
              ? handleTransferSla(tx, current(), timer)
              : item.handle(tx, timer),
        }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    portImplementations: implementations,
    subscribers,
    timerHandlers,
    subscriber: (name) => subscribers.find((item) => item.name === name),
    timerHandler: (name) => timerHandlers.find((item) => item.kind === name),
    portEntries<T>(port: KeyedPort<T>) {
      const entries = new Map(base.portEntries(port));
      if (port === approvalKindPort) entries.set("transfer_confirm", kind as T);
      return entries;
    },
  };
  return {
    assembly,
    attach(value: BillingPurchaseDeps) {
      if (closed || deps) throw new TypeError("对公复核运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
export async function decideTransferReview(
  tx: Tx,
  deps: BillingPurchaseDeps,
  approval: Approval,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: TransferProofApproveReviewBody | TransferProofRejectReviewBody,
  approve: boolean,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, "finance.receipt.confirm", deps.clock.now(), { skipStepUp: !approve });
  const proof = await proofInScope(tx, staff.scope, id);
  if (!proof.reviewApprovalRequestId || proof.reviewApprovalRequestId !== body.approvalId)
    throw new AppError("APPROVAL_NOT_PENDING");
  await orderInScope(tx, staff.scope, proof.billingOrderId);
  const audit = {
    stream: "ops" as const,
    category: "payment" as const,
    action: approve
      ? ("billing.transfer_proof.approve_review" as const)
      : ("billing.transfer_proof.reject_review" as const),
    summary: approve ? "复核对公到账" : "退回对公到账复核",
    target: { type: "transfer_proof" as const, id },
    entityId: proof.entityId,
  };
  if (approve) {
    const input = TransferProofApproveReviewBodySchema.parse(body);
    await approval.approve(tx, ctx, {
      approvalId: proof.reviewApprovalRequestId,
      staff,
      lockVersion: input.lockVersion,
      confirmChecks: input.confirmChecks,
      args: input,
      audit,
    });
  } else
    await approval.reject(tx, ctx, {
      approvalId: proof.reviewApprovalRequestId,
      staff,
      note: (body as TransferProofRejectReviewBody).note,
      audit,
    });
  const result = await proofDetailView(tx, deps, await proofInScope(tx, staff.scope, id), staff);
  return approve ? { ...result, outcome: "paid" as const } : result;
}
