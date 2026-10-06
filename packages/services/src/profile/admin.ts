import { ManagerAssignResultSchema } from "@liyoxi/contract";
import type {
  QualificationApproveBody,
  QualificationRejectBody,
  ManagerAssignBody,
  StoreListQuery,
} from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import {
  adminQualificationGet,
  adminStoreGet,
  adminStoreList,
  scopedRound,
  staffBrief,
} from "./admin-read.js";
import { assignDeliveryManager } from "./assign-manager.js";
import type { ProfileDeps, WriteOptions } from "./context.js";
import { withQualificationCall } from "./qualification-kind.js";
export function createAdminProfile(deps: ProfileDeps) {
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
    if (input.confirm?.roundNo !== first.roundNo || input.confirm?.roundNo !== row.roundNo)
      throw new AppError("CONFIRM_MISMATCH");
    return aid;
  }
  return {
    list: (staff: StaffContext, q: StoreListQuery) =>
      deps.tx.run((tx) => adminStoreList(tx, deps, staff, q)),
    get: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => adminStoreGet(tx, deps, staff, id)),
    qualification: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => adminQualificationGet(tx, deps, staff, id)),
    approve: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: QualificationApproveBody,
      options: WriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const approvalId = await guard(tx, staff, id, input);
        await withQualificationCall(tx, deps, ctx, () =>
          deps.approval.approve(tx, ctx, {
            approvalId,
            staff,
            lockVersion: input.lockVersion,
            confirmChecks: input.confirmChecks,
            args: input,
          }),
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
        const approvalId = await guard(tx, staff, id, input);
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
