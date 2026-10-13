import { ManagerAssignResultSchema } from "@liyoxi/contract";
import type {
  QualificationApproveBody,
  QualificationRejectBody,
  ManagerAssignBody,
  StoreListQuery,
  QualificationDocReviewBody,
  StoreActivityQuery,
} from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { readStoreActivity } from "../audit/index.js";
import { authorize } from "../authz/index.js";
import {
  adminQualificationGet,
  adminStoreGet,
  adminStoreList,
  scopedRound,
  staffBrief,
  scopedStore,
} from "./admin-read.js";
import { assignDeliveryManager } from "./assign-manager.js";
import type { ProfileDeps, WriteOptions } from "./context.js";
import { withQualificationCall } from "./qualification-kind.js";
import { QualificationImpactPort } from "./ports.js";
import { reviewDocument } from "./admin-review.js";
import { currentReviewStaff } from "./admin-authorization.js";
import { createAdminStoreProfile } from "./admin-store-profile.js";
import { adminStoreQualification } from "./admin-store-qualification.js";
export function createAdminProfile(deps: ProfileDeps) {
  const storeProfile = createAdminStoreProfile(deps);
  async function guard(
    tx: Tx,
    staff: StaffContext,
    id: string,
    input: QualificationApproveBody | QualificationRejectBody,
  ) {
    const first = await scopedRound(tx, staff, id),
      aid = first.approvalRequestId!;
    const staffIds = [
      staff.staff.id,
      ...(first.approvalRequest!.requesterStaffId ? [first.approvalRequest!.requesterStaffId] : []),
    ];
    await lockRows(tx, "staff", [...new Set(staffIds)].sort(), "share");
    await lockRows(tx, "approval_request", [aid]);
    staff = await currentReviewStaff(tx, staff, deps.clock.now());
    await scopedRound(tx, staff, id);
    const row = await tx.approvalRequest.findUniqueOrThrow({ where: { id: aid } });
    if (row.status !== "pending")
      throw new AppError("APPROVAL_NOT_PENDING", {
        details: { status: row.status, decidedAt: row.decidedAt?.toISOString() ?? null },
      });
    if (row.requesterStaffId === staff.staff.id || row.submitActorId === staff.staff.id)
      throw new AppError("APPROVAL_SELF_FORBIDDEN");
    const actor = await tx.staff.findUnique({ where: { id: staff.staff.id } });
    if (actor?.status !== "active") throw new AppError("PERMISSION_DENIED");
    assertPermission(staff, "merchant.qualification.review", deps.clock.now());
    if ("mode" in input && input.mode === "override")
      assertPermission(staff, "merchant.qualification.override", deps.clock.now());
    if ("lockVersion" in input && input.lockVersion !== row.lockVersion)
      throw new AppError("VERSION_CONFLICT", { details: { lockVersion: row.lockVersion } });
    if (
      !("isFinal" in input && input.isFinal) &&
      (input.confirm?.roundNo !== first.roundNo || input.confirm?.roundNo !== row.roundNo)
    )
      throw new AppError("CONFIRM_MISMATCH");
    return { approvalId: aid, current: staff };
  }
  return {
    profile: storeProfile.get,
    updateProfile: storeProfile.update,
    reviewDocument: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: QualificationDocReviewBody,
      options: WriteOptions = {},
    ) => deps.tx.run((tx) => reviewDocument(tx, deps, ctx, staff, id, input), options),
    list: (staff: StaffContext, q: StoreListQuery) =>
      deps.tx.run((tx) => adminStoreList(tx, deps, staff, q)),
    get: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => adminStoreGet(tx, deps, staff, id)),
    activity: (staff: StaffContext, id: string, query: StoreActivityQuery) =>
      deps.tx.run(async (tx) => {
        authorize(
          staff,
          { module: { module: "merchant", need: "view" }, permission: null },
          deps.clock.now(),
        );
        return readStoreActivity(tx, await scopedStore(tx, staff, id), query);
      }),
    qualification: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => adminQualificationGet(tx, deps, staff, id)),
    storeQualification: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => adminStoreQualification(tx, deps, staff, id)),
    rejectQuote: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) => {
        assertPermission(staff, "merchant.qualification.review", deps.clock.now());
        const round = await scopedRound(tx, staff, id);
        if (round.approvalRequest!.status !== "pending" || round.closedAt)
          throw new AppError("APPROVAL_NOT_PENDING");
        if (round.kind === "change") throw new AppError("QUALIFICATION_FINAL_NOT_ALLOWED");
        return deps.assembly
          .port(QualificationImpactPort)
          .previewFinalReject(
            tx,
            { entityId: round.entityId, storeId: round.storeId },
            deps.clock.now(),
          );
      }),
    approve: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: QualificationApproveBody,
      options: WriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const { approvalId, current } = await guard(tx, staff, id, input);
        staff = current;
        const round = await scopedRound(tx, staff, id);
        await withQualificationCall(
          tx,
          deps,
          ctx,
          () =>
            deps.approval.approve(tx, ctx, {
              approvalId,
              staff,
              lockVersion: input.lockVersion,
              confirmChecks: input.confirmChecks,
              note: input.mode === "override" ? input.overrideReason : undefined,
              ...(input.mode === "override"
                ? {
                    audit: {
                      stream: "activity" as const,
                      category: "review" as const,
                      action: "approval.request.approve",
                      summary: "放行资质审核",
                      target: { type: "approval_request", id: approvalId },
                      entityId: round.entityId,
                      storeId: round.storeId,
                      reason: { code: "override", text: input.overrideReason },
                      meta: {
                        approvalStatus: "approved",
                        approvalKind: "qualification",
                        rule: "override",
                      },
                    },
                  }
                : {}),
              args: input,
            }),
          staff,
        );
        return adminQualificationGet(tx, deps, staff, id);
      }, options),
    reject: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: QualificationRejectBody,
      options: WriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const { approvalId, current } = await guard(tx, staff, id, input);
        staff = current;
        await withQualificationCall(tx, deps, ctx, () =>
          deps.approval.reject(tx, ctx, {
            approvalId,
            staff,
            reasonCodes: input.reasonCodes,
            note: input.note,
            args: input,
          }),
        );
        return adminQualificationGet(tx, deps, staff, id);
      }, options),
    assign: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: ManagerAssignBody,
      options: WriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const result = await assignDeliveryManager(tx, deps, ctx, {
          storeId: id,
          staffId: input.toStaffId,
          scope: staff.scope,
          allowArchived: true,
          note: input.note,
        });
        return ManagerAssignResultSchema.parse({
          storeId: id,
          deliveryManager: (await staffBrief(tx, input.toStaffId))!,
          synced: result.synced,
        });
      }, options),
  };
}
