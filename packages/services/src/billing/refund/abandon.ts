import { z } from "zod";
import { assertPermission } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { AppError, createActor, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { staffContextOf } from "../../staff/index.js";
import type { StaffPrincipal } from "../../staff/index.js";
import { assertStaff, lockRefund, visible } from "./context.js";
import type { RefundDeps } from "./context.js";
import { failed } from "./state.js";
import { createIdentityContext } from "../../kernel/index.js";

const confirmation = z.strictObject({
  requestNo: z.string().min(1),
  outRefundNo: z.string().min(1),
});
export const abandonSchema = z.strictObject({
  refundTxnId: z.uuid(),
  evidenceFileId: z.uuid(),
  note: z.string().trim().min(5).max(200),
  financeConfirm: confirmation,
  administratorConfirm: confirmation,
});
export type AbandonInput = z.infer<typeof abandonSchema>;
/** CLI运输先用真实staffAuth.authenticate验证两个opaque会话；本事务再核会话/角色/权限与业务事实。 */
export interface RefundConfirmers {
  finance: StaffPrincipal;
  administrator: StaffPrincipal;
}
export async function abandon(
  tx: Tx,
  deps: RefundDeps,
  confirmers: RefundConfirmers,
  raw: AbandonInput,
) {
  const input = abandonSchema.parse(raw),
    first = confirmers.finance,
    second = confirmers.administrator;
  if (first.staff.id === second.staff.id) throw new AppError("PERMISSION_DENIED");
  await lockRows(tx, "staff", [first.staff.id, second.staff.id], "share");
  const now = deps.clock.now();
  const checked = [];
  for (const person of [first, second]) {
    const session = await tx.staffSession.findFirst({
      where: {
        id: person.session.id,
        staffId: person.staff.id,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    });
    if (!session) throw new AppError("SESSION_INVALID");
    const role = await tx.staffRole.findUniqueOrThrow({
      where: { key: person.staff.staffRoleKey },
    });
    const group = person.staff.staffGroupId
      ? await tx.staff.findMany({
          where: { staffGroupId: person.staff.staffGroupId, status: "active" },
          select: { id: true },
        })
      : [];
    checked.push(
      staffContextOf({
        ...person,
        role,
        groupMemberIds: group.map((s) => s.id),
        session: { ...person.session, stepupAt: session.stepupAt },
      }),
    );
  }
  const [finance, administrator] = checked;
  if (!finance || !administrator) throw new AppError("SESSION_INVALID");
  const ctx = createIdentityContext({
    actor: { type: "staff", id: first.staff.id, client: "admin" },
  });
  await assertStaff(tx, deps, ctx, finance, "finance.refund.execute");
  await assertStaff(
    tx,
    deps,
    createIdentityContext({ actor: { type: "staff", id: second.staff.id, client: "admin" } }),
    administrator,
    "finance.refund.execute",
  );
  if (first.staff.staffRoleKey !== "finance" || second.staff.staffRoleKey !== "super_admin")
    throw new AppError("PERMISSION_DENIED");
  assertPermission(administrator, "finance.refund.execute", now);
  const before = await tx.refundTxn.findUnique({ where: { id: input.refundTxnId } });
  if (!before?.refundRequestId) throw new AppError("NOT_FOUND");
  await visible(tx, finance, before.refundRequestId);
  await visible(tx, administrator, before.refundRequestId);
  const state = await lockRefund(tx, before.refundRequestId),
    txn = state.txns.find((t) => t.id === before.id)!;
  if (txn.status !== "abnormal" || state.request.status !== "executing")
    throw new AppError("STATE_NOT_ALLOWED");
  for (const confirm of [input.financeConfirm, input.administratorConfirm])
    if (confirm.requestNo !== state.approval.requestNo || confirm.outRefundNo !== txn.outRefundNo)
      throw new AppError("CONFIRM_MISMATCH");
  await lockRows(tx, "file_object", [input.evidenceFileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.evidenceFileId } });
  if (
    !file ||
    file.status !== "stored" ||
    file.category !== "pay_receipt" ||
    file.moderationState === "block" ||
    file.uploadActorType !== "staff" ||
    ![first.staff.id, second.staff.id].includes(file.uploadActorId ?? "") ||
    (txn.entityId
      ? file.scopeType !== "entity" || file.entityId !== txn.entityId
      : file.scopeType !== "platform")
  )
    throw new AppError("FILE_NOT_USABLE");
  await deps.media.link(tx, {
    fileId: file.id,
    refType: "refund_txn",
    refId: txn.id,
    role: "abandon_evidence",
    entityId: txn.entityId,
    storeId: null,
  });
  await tx.refundTxn.update({
    where: { id: txn.id },
    data: {
      status: "abandoned",
      isRetryHalted: true,
      failCode: "abandoned",
      failMessage: "经双人确认无法继续退款，原渠道晚到事实仍会接纳",
      updatedAt: now,
    },
  });
  await failed(tx, deps, state, txn.id, "abandoned");
  await deps.timers.cancel(tx, { subject: { type: "refund_txn", id: txn.id }, kinds: ["rf.poll"] });
  await record(
    tx,
    createActor({ type: "staff", id: first.staff.id, client: "cli" }),
    {
      requestId: null,
      ip: null,
      userAgent: null,
      sessionId: first.session.id,
      authMethod: null,
      jobName: "cli.refund.abandon_txn",
    },
    {
      stream: "ops",
      category: "refund",
      action: "finance.refund.abandon_txn",
      summary: "财务与超级管理员确认放弃异常退款",
      target: { type: "refund_txn", id: txn.id },
      ...(txn.entityId ? { entityId: txn.entityId } : { entityId: null }),
      reason: { code: "other", text: input.note },
      meta: {
        financeStaffId: first.staff.id,
        administratorStaffId: second.staff.id,
        evidenceFileId: file.id,
        outRefundNo: txn.outRefundNo,
      },
    },
  );
  return { refundTxnId: txn.id, status: "abandoned" as const };
}
