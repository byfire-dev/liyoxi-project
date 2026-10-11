import { maskName } from "@liyoxi/shared/mask";
import { defineApprovalKind } from "../approval/index.js";
import type { ApprovalDecision, ApprovalRow } from "../approval/index.js";
import { AppError, isUniqueViolation, lockRows, savepoint } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { encryptField, sealUscc } from "../security/index.js";
import { findVerifiedEntityByUsccBidx, USCC_UNIQUE_INDEX } from "../tenant/index.js";
import type { ProfileDeps } from "./context.js";
import {
  dictRef,
  ensureProfile,
  refreshCompleteness,
  roundInclude,
  storeOf,
  submittedFields,
} from "./repo.js";
import { invalid } from "./validate.js";
import { onLifecycleWithdrawn } from "./lifecycle-withdrawal.js";

// 登记是静态的，依赖由领域用例按本事务绑定，避免不同 runtime/测试之间共享服务实例。
const calls = new WeakMap<Tx, { deps: ProfileDeps; ctx: IdentityContext }>();
export async function withQualificationCall<T>(
  tx: Tx,
  deps: ProfileDeps,
  ctx: IdentityContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (calls.has(tx)) throw new Error("资质领域用例不能重入");
  calls.set(tx, { deps, ctx });
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}
function call(tx: Tx) {
  const bound = calls.get(tx);
  if (!bound) throw new Error("资质决定必须从 profile 领域用例进入");
  return bound;
}
interface DecideArgs {
  confirm: { roundNo: number };
  mode?: "normal" | "override";
  rejectedDocIds?: readonly string[];
  isFinal?: boolean;
}
async function lockedRound(tx: Tx, row: ApprovalRow, args: unknown) {
  const first = await tx.qualificationSubmission.findUnique({
    where: { approvalRequestId: row.id },
  });
  if (!first) throw new AppError("NOT_FOUND");
  await lockRows(tx, "qualification_submission", [first.id]);
  const round = await tx.qualificationSubmission.findUniqueOrThrow({
    where: { id: first.id },
    include: roundInclude,
  });
  const input = args as DecideArgs;
  if (input?.confirm?.roundNo !== round.roundNo || input.confirm.roundNo !== row.roundNo)
    throw new AppError("CONFIRM_MISMATCH");
  if (round.closedAt || !round.submittedAt) throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "entity", [round.entityId]);
  await lockRows(tx, "store", [round.storeId]);
  const store = await storeOf(tx, round.storeId);
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("PRECONDITION_CHANGED");
  if (round.kind !== "initial") throw new AppError("STATE_NOT_ALLOWED");
  return { round, store, input };
}
async function conclude(tx: Tx, row: ApprovalRow, decision: ApprovalDecision, approved: boolean) {
  const { deps, ctx } = call(tx);
  const { round, input } = await lockedRound(tx, row, decision.args);
  if (!approved && input.isFinal)
    throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "final_reject_not_open" } });
  const now = decision.decidedAt;
  const p = await ensureProfile(tx, round.storeId, now);
  if (approved) {
    const license = round.qualificationDocs.find((doc) => doc.docType === "business_license")!;
    const fields = submittedFields(deps.keyring(), license);
    const sealed = sealUscc(deps.keyring(), "entity.uscc_enc", fields["uscc"]!);
    const principal = fields["principal"] ?? null;
    try {
      await savepoint(tx, () =>
        deps.tenant.setStoreQualification(tx, ctx, {
          storeId: round.storeId,
          round: "initial",
          action: "approve",
          verified: {
            name: fields["name"]!,
            entityType: round.claimedEntityType as "enterprise" | "individual",
            usccEnc: sealed.enc,
            usccBidx: sealed.bidx,
            usccMask: sealed.mask,
            legalRepNameEnc: principal
              ? encryptField(deps.keyring(), "entity.legal_rep_name_enc", principal)
              : null,
            legalRepNameMask: principal ? maskName(principal) : null,
          },
          audit: { mergedInto: { approvalRequestId: row.id } },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, [USCC_UNIQUE_INDEX])) throw new AppError("USCC_TAKEN");
      throw error;
    }
    // 唯一生效索引要求先替代旧行，再生效新行。
    await tx.qualificationDoc.updateMany({
      where: {
        effectiveAt: { not: null },
        supersededAt: null,
        OR: [
          { entityId: round.entityId, scope: "entity" },
          { storeId: round.storeId, scope: "store" },
        ],
      },
      data: { supersededAt: now, updatedAt: now },
    });
    await tx.qualificationDoc.updateMany({
      where: { qualificationSubmissionId: round.id, removedAt: null },
      data: { verdict: "accepted", effectiveAt: now, updatedAt: now },
    });
    await tx.storeProfile.update({
      where: { storeId: round.storeId },
      data: {
        effectiveQualificationSubmissionId: round.id,
        firstVerifiedAt: p.firstVerifiedAt ?? now,
        lastDecidedAt: now,
        updatedAt: now,
      },
    });
  } else {
    const ids = [...new Set(input.rejectedDocIds ?? [])];
    if (ids.some((id) => !round.qualificationDocs.some((doc) => doc.id === id)))
      throw invalid("驳回的证照不是本轮在用行");
    for (const code of decision.reasonCodes) {
      const reason = await tx.dictItem.findUnique({
        where: { dictTypeKey_code: { dictTypeKey: "reject_reason", code } },
      });
      if (!reason?.isEnabled || !((reason.ext as { scene?: string }).scene === "store_review"))
        throw invalid("原因不属于启用的商家审核场景");
    }
    await deps.tenant.setStoreQualification(tx, ctx, {
      storeId: round.storeId,
      round: "initial",
      action: "reject",
      rejection: { reasonCodes: decision.reasonCodes, note: decision.note! },
      audit: { mergedInto: { approvalRequestId: row.id } },
    });
    await tx.qualificationDoc.updateMany({
      where: { qualificationSubmissionId: round.id, removedAt: null },
      data: { verdict: "accepted", updatedAt: now },
    });
    await tx.qualificationDoc.updateMany({
      where: { id: { in: ids } },
      data: { verdict: "rejected", updatedAt: now },
    });
    await tx.storeProfile.update({
      where: { storeId: round.storeId },
      data: { lastDecidedAt: now, updatedAt: now },
    });
  }
  await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: {
      closedAt: now,
      outcome: approved ? "approved" : "rejected",
      approveMode: approved ? "normal" : null,
      updatedAt: now,
    },
  });
  await refreshCompleteness(tx, round.storeId, now);
  await deps.events.emit(tx, ctx, {
    type: approved ? "store.qualification.approved" : "store.qualification.rejected",
    aggregate: { type: "store", id: round.storeId },
    payload: approved
      ? {
          v: 1,
          storeId: round.storeId,
          entityId: round.entityId,
          submissionId: round.id,
          kind: "initial",
        }
      : {
          v: 1,
          storeId: round.storeId,
          entityId: round.entityId,
          submissionId: round.id,
          isFinal: false,
          reasonCodes: [...decision.reasonCodes],
          isSystem: decision.isDecidedBySystem,
        },
  });
}
export const qualificationKind = defineApprovalKind<{ submissionId: string; roundNo: number }>({
  category: "review",
  domain: { table: "qualification_submission", column: "approval_request_id" },
  viewModules: ["merchant"],
  decidePermission: "merchant.qualification.review",
  groupBound: false,
  hasExecution: false,
  numberPrefix: null,
  dedupeKey: (s) => `qualification:${s.storeId}`,
  roundNo: async (_tx, s) => s.input.roundNo,
  operations: {
    get: "admin.qualificationSubmission.get",
    approve: "admin.qualificationSubmission.approve",
    reject: "admin.qualificationSubmission.reject",
    withdraw: null,
  },
  async validate(tx, s) {
    const round = await tx.qualificationSubmission.findFirst({
      where: {
        id: s.input.submissionId,
        storeId: s.storeId!,
        entityId: s.entityId!,
        closedAt: null,
        submittedAt: null,
      },
    });
    if (!round) throw new AppError("STATE_NOT_ALLOWED");
  },
  async summarize(tx, s) {
    const round = await tx.qualificationSubmission.findUniqueOrThrow({
      where: { id: s.input.submissionId },
      include: roundInclude,
    });
    const store = await storeOf(tx, s.storeId!);
    const p = await tx.storeProfile.findUniqueOrThrow({ where: { storeId: store.id } });
    const region = [];
    for (const code of [p.provinceCode, p.cityCode, p.districtCode])
      region.push(await dictRef(tx, "region", code));
    const industry = await dictRef(tx, "industry", p.industryCode),
      category = await dictRef(tx, "industry", p.categoryCode);
    return {
      title: store.name!,
      lines: [
        { label: "门店", value: store.name! },
        {
          label: "主体",
          value:
            round.qualificationDocs.find((doc) => doc.docType === "business_license")?.holderName ??
            store.entity.name ??
            "",
        },
        { label: "品类", value: `${industry?.name ?? ""} / ${category?.name ?? ""}` },
        { label: "区域", value: region.map((r) => r?.name ?? "").join(" / ") },
        {
          label: "提交类型",
          value: `首次认证${round.resubmitOfQualificationSubmissionId ? " · 重新提交" : ""}`,
        },
      ],
      domain: { type: "qualification_submission", id: round.id },
    };
  },
  async handlerOf(tx, row) {
    if (!row.storeId) return null;
    return (
      (
        await tx.store.findUnique({
          where: { id: row.storeId },
          select: { deliveryManagerId: true },
        })
      )?.deliveryManagerId ?? null
    );
  },
  async revalidate(tx, row, args) {
    const { deps } = call(tx);
    const { round, input } = await lockedRound(tx, row, args);
    if (input.mode && input.mode !== "normal")
      throw new AppError("STATE_NOT_ALLOWED", {
        details: { reason: "recognition_override_not_open" },
      });
    const license = round.qualificationDocs.find((doc) => doc.docType === "business_license");
    if (!license?.certNoBidx || !round.claimedEntityType)
      throw new AppError("PRECONDITION_CHANGED");
    if (await findVerifiedEntityByUsccBidx(tx, license.certNoBidx, round.entityId))
      throw new AppError("USCC_TAKEN");
    void deps;
  },
  onApproved: (tx, row, decision) => conclude(tx, row, decision, true),
  onRejected: (tx, row, decision) => conclude(tx, row, decision, false),
  onWithdrawn: onLifecycleWithdrawn,
});
