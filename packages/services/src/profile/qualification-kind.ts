import { maskName } from "@liyoxi/shared/mask";
import { QUALIFICATION_DUPLICATE_REJECT_NOTE } from "@liyoxi/contract";
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
import { roundBasics, type RoundAddress } from "./round-basics.js";

// 登记是静态的，依赖由领域用例按本事务绑定，避免不同 runtime/测试之间共享服务实例。
type DecisionDeps = Pick<ProfileDeps, "clock" | "tenant" | "events"> &
  Partial<Pick<ProfileDeps, "keyring">>;
const calls = new WeakMap<
  Tx,
  { deps: DecisionDeps; ctx: IdentityContext; duplicate?: { roundId: string; winnerId: string } }
>();
export async function withSystemDuplicateCall<T>(
  tx: Tx,
  deps: DecisionDeps,
  ctx: IdentityContext,
  duplicate: { roundId: string; winnerId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.actor.type !== "system" || calls.has(tx))
    throw new TypeError("系统重复资质拒绝必须绑定当前事务");
  calls.set(tx, { deps, ctx, duplicate });
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}
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
const changeLabels: Record<string, string> = {
  store_name: "门店名称",
  address: "地址",
  industry: "行业品类",
  docs: "门店证照",
  entity_license: "主体执照",
};
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
  if (
    (round.kind === "initial" &&
      (!store.isPrimary || store.entity.verificationStatus !== "pending")) ||
    (round.kind !== "initial" && store.entity.verificationStatus !== "verified") ||
    (round.kind === "change"
      ? store.qualificationStatus !== "verified"
      : store.qualificationStatus !== "pending")
  )
    throw new AppError("PRECONDITION_CHANGED");
  return { round, store, input };
}
async function conclude(tx: Tx, row: ApprovalRow, decision: ApprovalDecision, approved: boolean) {
  const { deps, ctx } = call(tx);
  const { round, input } = await lockedRound(tx, row, decision.args);
  const duplicate = call(tx).duplicate;
  if (!approved && !duplicate && decision.reasonCodes.length === 0)
    throw new AppError("PRECONDITION_CHANGED");
  if (duplicate) {
    const license = round.qualificationDocs.find((doc) => doc.docType === "business_license");
    const winner = license?.certNoBidx
      ? await findVerifiedEntityByUsccBidx(tx, license.certNoBidx, round.entityId)
      : null;
    if (
      approved ||
      ctx.actor.type !== "system" ||
      !decision.isDecidedBySystem ||
      duplicate.roundId !== round.id ||
      winner?.id !== duplicate.winnerId ||
      decision.note !== QUALIFICATION_DUPLICATE_REJECT_NOTE ||
      decision.reasonCodes.length ||
      input.rejectedDocIds?.length !== 1 ||
      input.rejectedDocIds[0] !== license?.id
    )
      throw new AppError("PRECONDITION_CHANGED");
  }
  if (!approved && input.isFinal && round.kind === "change")
    throw new AppError("QUALIFICATION_FINAL_NOT_ALLOWED");
  if (!approved && input.isFinal)
    throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "final_reject_not_open" } });
  const now = decision.decidedAt;
  const p = await ensureProfile(tx, round.storeId, now);
  if (approved) {
    if (!deps.keyring) throw new TypeError("批准资质必须绑定真实字段密钥能力");
    const keyring = deps.keyring();
    const license = round.qualificationDocs.find((doc) => doc.docType === "business_license");
    const fields = license ? submittedFields(keyring, license) : {};
    const sealed = license ? sealUscc(keyring, "entity.uscc_enc", fields["uscc"]!) : null;
    const principal = fields["principal"] ?? null;
    try {
      await savepoint(tx, () =>
        deps.tenant.setStoreQualification(tx, ctx, {
          storeId: round.storeId,
          round: round.kind as "initial" | "new_store" | "change",
          submissionId: round.id,
          action: "approve",
          ...(sealed
            ? {
                verified: {
                  name: fields["name"]!,
                  entityType: round.claimedEntityType as "enterprise" | "individual",
                  usccEnc: sealed.enc,
                  usccBidx: sealed.bidx,
                  usccMask: sealed.mask,
                  legalRepNameEnc: principal
                    ? encryptField(keyring, "entity.legal_rep_name_enc", principal)
                    : null,
                  legalRepNameMask: principal ? maskName(principal) : null,
                },
              }
            : {}),
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
          ...(license ? [{ entityId: round.entityId, scope: "entity" }] : []),
          { storeId: round.storeId, scope: "store" },
        ],
      },
      data: { supersededAt: now, updatedAt: now },
    });
    await tx.qualificationDoc.updateMany({
      where: { qualificationSubmissionId: round.id, removedAt: null },
      data: { verdict: "accepted", effectiveAt: now, updatedAt: now },
    });
    const fieldsToWrite = round.kind === "change" ? round.changedFields : [];
    if (fieldsToWrite.includes("store_name"))
      await deps.tenant.renameStore(tx, ctx, {
        storeId: round.storeId,
        name: round.proposedStoreName!,
        submissionId: round.id,
      });
    const a = round.proposedAddressSnapshot as RoundAddress;
    await tx.storeProfile.update({
      where: { storeId: round.storeId },
      data: {
        ...(fieldsToWrite.includes("industry")
          ? { industryCode: round.proposedIndustryCode, categoryCode: round.proposedCategoryCode }
          : {}),
        ...(fieldsToWrite.includes("address")
          ? {
              provinceCode: a.provinceCode,
              cityCode: a.cityCode,
              districtCode: a.districtCode,
              addressDetail: a.detail,
            }
          : {}),
        ...(fieldsToWrite.some((f) => ["store_name", "industry", "address"].includes(f))
          ? { lockVersion: { increment: 1 } }
          : {}),
        effectiveQualificationSubmissionId: round.id,
        firstVerifiedAt: p.firstVerifiedAt ?? now,
        lastDecidedAt: now,
        updatedAt: now,
      },
    });
    const written = fieldsToWrite.filter((f) => ["store_name", "industry", "address"].includes(f));
    if (written.length)
      await deps.events.emit(tx, ctx, {
        type: "store.profile.changed",
        aggregate: { type: "store", id: round.storeId },
        payload: {
          v: 1,
          storeId: round.storeId,
          entityId: round.entityId,
          fields: written,
          source: "review_writeback",
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
      round: round.kind as "initial" | "new_store" | "change",
      submissionId: round.id,
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
      ...(duplicate ? { systemRejectCode: "duplicate_entity" } : {}),
      approveMode: approved ? "normal" : null,
      updatedAt: now,
    },
  });
  await refreshCompleteness(tx, round.storeId, now);
  await deps.events.emit(
    tx,
    ctx,
    round.kind === "change"
      ? {
          type: approved
            ? "store.qualification_change.approved"
            : "store.qualification_change.rejected",
          aggregate: { type: "store", id: round.storeId },
          payload: approved
            ? {
                v: 1,
                storeId: round.storeId,
                entityId: round.entityId,
                submissionId: round.id,
                changedFields: round.changedFields,
              }
            : {
                v: 1,
                storeId: round.storeId,
                entityId: round.entityId,
                submissionId: round.id,
                reasonCodes: [...decision.reasonCodes],
              },
        }
      : {
          type: approved ? "store.qualification.approved" : "store.qualification.rejected",
          aggregate: { type: "store", id: round.storeId },
          payload: approved
            ? {
                v: 1,
                storeId: round.storeId,
                entityId: round.entityId,
                submissionId: round.id,
                kind: round.kind as "initial" | "new_store",
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
        },
  );
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
    const proposed = roundBasics({ store, profile: p }, round);
    const region = [];
    for (const code of [
      proposed.address.provinceCode,
      proposed.address.cityCode,
      proposed.address.districtCode,
    ])
      region.push(await dictRef(tx, "region", code));
    const industry = await dictRef(tx, "industry", proposed.industryCode),
      category = await dictRef(tx, "industry", proposed.categoryCode);
    return {
      title: proposed.storeName!,
      lines: [
        { label: "门店", value: proposed.storeName! },
        {
          label: "主体",
          value:
            (round.kind === "initial"
              ? round.qualificationDocs.find((doc) => doc.docType === "business_license")
                  ?.holderName
              : null) ??
            store.entity.name ??
            "",
        },
        { label: "品类", value: `${industry?.name ?? ""} / ${category?.name ?? ""}` },
        { label: "区域", value: region.map((r) => r?.name ?? "").join(" / ") },
        {
          label: "提交类型",
          value: `${round.kind === "change" ? `变更重审 · ${round.changedFields.map((f) => changeLabels[f] ?? f).join("、")}` : round.kind === "new_store" ? "新增门店" : "首次认证"}${round.resubmitOfQualificationSubmissionId ? " · 重新提交" : ""}`,
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
    if (
      (round.kind === "initial" && !license) ||
      (license && (!license.certNoBidx || !round.claimedEntityType))
    )
      throw new AppError("PRECONDITION_CHANGED");
    if (
      license?.certNoBidx &&
      (await findVerifiedEntityByUsccBidx(tx, license.certNoBidx, round.entityId))
    )
      throw new AppError("USCC_TAKEN");
    void deps;
  },
  onApproved: (tx, row, decision) => conclude(tx, row, decision, true),
  onRejected: (tx, row, decision) => conclude(tx, row, decision, false),
  onWithdrawn: onLifecycleWithdrawn,
});
