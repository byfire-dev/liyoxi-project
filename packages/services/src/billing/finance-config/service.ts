import { isDeepStrictEqual } from "node:util";
import type {
  FinanceConfigCreateBody,
  FinanceConfigApproveBody,
  FinanceConfigRejectBody,
  FinanceConfigWithdrawBody,
  FinanceConfigListQuery,
} from "@liyoxi/contract";
import type { IdentityContext, IdempotencyContext, Tx } from "../../kernel/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import { assertPermission, satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { openField } from "../../security/index.js";
import type { BillingPurchaseDeps } from "../payment/purchase-context.js";
import { proposeFinanceConfig } from "./index.js";
import { financeConfigView, financeConfigWithdrawnView, listFinanceConfigs } from "./read.js";
export async function assertFinanceStaff(
  tx: Tx,
  deps: Pick<BillingPurchaseDeps, "clock">,
  ctx: IdentityContext,
  staff: StaffContext,
  permission?: Parameters<typeof assertPermission>[1],
  skipStepUp = false,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  if (permission) assertPermission(staff, permission, deps.clock.now(), { skipStepUp });
  await lockRows(tx, "staff", [staff.staff.id], "share");
  const row = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !row ||
    row.status !== "active" ||
    row.staffRoleKey !== staff.staff.roleKey ||
    row.staffGroupId !== staff.staff.staffGroupId ||
    row.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
}
export function createFinanceConfigService(deps: BillingPurchaseDeps) {
  const approval = deps.approval;
  const required = () => {
    if (!approval) throw new AppError("INTERNAL");
    return approval;
  };
  const rowAt = async (tx: Tx, id: string) => {
    const row = await tx.financeConfigRevision.findUnique({ where: { id } });
    if (!row) throw new AppError("NOT_FOUND");
    return row;
  };
  const view = (tx: Tx, staff: StaffContext, id: string) =>
    rowAt(tx, id).then((row) => financeConfigView(tx, required(), staff, row, deps.clock.now()));
  const audit = (
    tx: Tx,
    ctx: IdentityContext,
    id: string,
    action: "propose" | "approve" | "reject" | "withdraw",
    key: string,
  ) =>
    record(
      tx,
      ctx.actor,
      {
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "ops",
        category: "finance_config",
        action: `billing.finance_config.${action}`,
        summary: "受控财务配置处理",
        target: { type: "finance_config_revision", id },
        entityId: null,
        storeId: null,
        meta: { configKey: key },
      },
    );
  return {
    list: (staff: StaffContext, query: FinanceConfigListQuery) =>
      deps.tx.run((tx) => listFinanceConfigs(tx, required(), staff, query, deps.clock.now())),
    create: async (
      ctx: IdentityContext,
      staff: StaffContext,
      input: FinanceConfigCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run((tx) => assertFinanceStaff(tx, deps, ctx, staff, "finance.config.propose"));
      return deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.config.propose");
        const current = await tx.financeConfigRevision.findFirst({
          where: {
            configKey: input.configKey,
            effectiveAt: { lte: deps.clock.now() },
            approvalRequest: { status: "approved" },
          },
          orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
        });
        if (
          input.confirm.configKey !== input.configKey ||
          input.confirm.baseRevisionId !== (current?.id ?? null)
        )
          throw new AppError("CONFIRM_MISMATCH");
        const before =
          current?.configKey === "bank_account"
            ? {
                ...(current.payload as { accountName: string; bankName: string }),
                accountNo: openField(
                  deps.keyring(),
                  "finance_config_revision.account_no_enc",
                  current.accountNoEnc!,
                ).replace(/\s/gu, ""),
              }
            : current?.payload;
        const candidate =
          input.configKey === "bank_account"
            ? {
                accountName: input.payload.accountName,
                bankName: input.payload.bankName,
                accountNo: input.payload.accountNo.replace(/\s/gu, ""),
              }
            : input.payload;
        if (before && input.configKey === "bank_account")
          delete (before as Record<string, unknown>).accountNoMask;
        if (isDeepStrictEqual(before, candidate)) throw new AppError("CHANGESET_EMPTY");
        const created = await proposeFinanceConfig(
          tx,
          { approval: required(), clock: deps.clock, keyring: deps.keyring() },
          ctx,
          input,
          staff,
          { idempotencyKey: options.idem?.key ?? null },
        );
        await deps.events.emit(tx, ctx, {
          type: "finance_config.proposed",
          aggregate: { type: "finance_config_revision", id: created.financeConfigRevisionId },
          payload: {
            v: 1,
            financeConfigRevisionId: created.financeConfigRevisionId,
            configKey: input.configKey,
            approvalRequestId: created.approvalId,
          },
        });
        await audit(tx, ctx, created.financeConfigRevisionId, "propose", input.configKey);
        return view(tx, staff, created.financeConfigRevisionId);
      }, options);
    },
    approve: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: FinanceConfigApproveBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.config.approve");
        await rowAt(tx, id);
      });
      return deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.config.approve");
        const row = await rowAt(tx, id);
        if (
          input.confirm.configKey !== row.configKey ||
          input.confirm.financeConfigRevisionId !== id ||
          (row.configKey === "bank_account" &&
            input.confirm.accountNoLast4 !==
              openField(deps.keyring(), "finance_config_revision.account_no_enc", row.accountNoEnc!)
                .replace(/\s/gu, "")
                .slice(-4))
        )
          throw new AppError("CONFIRM_MISMATCH");
        await required().approve(tx, ctx, {
          approvalId: row.approvalRequestId,
          staff,
          lockVersion: input.lockVersion,
          confirmChecks: input.confirmChecks,
          ...(input.note ? { note: input.note } : {}),
        });
        await deps.events.emit(tx, ctx, {
          type: "finance_config.approved",
          aggregate: { type: "finance_config_revision", id },
          payload: {
            v: 1,
            financeConfigRevisionId: id,
            configKey: row.configKey as "bank_account" | "purchase_policy" | "controls",
            effectiveAt: (
              await tx.financeConfigRevision.findUniqueOrThrow({ where: { id } })
            ).effectiveAt!.toISOString(),
          },
        });
        await audit(tx, ctx, id, "approve", row.configKey);
        return view(tx, staff, id);
      }, options);
    },
    reject: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: FinanceConfigRejectBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.config.approve", true);
        await rowAt(tx, id);
      });
      return deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.config.approve", true);
        const row = await rowAt(tx, id);
        await required().reject(tx, ctx, {
          approvalId: row.approvalRequestId,
          staff,
          note: input.note,
        });
        await audit(tx, ctx, id, "reject", row.configKey);
        return view(tx, staff, id);
      }, options);
    },
    withdraw: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: FinanceConfigWithdrawBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      const authorize = async (tx: Tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff);
        const row = await rowAt(tx, id),
          a = await tx.approvalRequest.findUniqueOrThrow({ where: { id: row.approvalRequestId } });
        if (a.requesterStaffId !== staff.staff.id) {
          const requester = a.requesterStaffId
            ? await tx.staff.findUnique({ where: { id: a.requesterStaffId } })
            : null;
          if (requester?.status === "active") throw new AppError("APPROVAL_WITHDRAW_FORBIDDEN");
          assertPermission(staff, "finance.config.approve", deps.clock.now());
        }
        return row;
      };
      await deps.tx.run(authorize);
      return deps.tx.run(async (tx) => {
        const row = await authorize(tx);
        await required().withdraw(tx, ctx, {
          approvalId: row.approvalRequestId,
          staff,
          ...(input.note ? { note: input.note } : {}),
        });
        await audit(tx, ctx, id, "withdraw", row.configKey);
        return satisfiesLevel(staff.moduleLevels.finance, "view")
          ? view(tx, staff, id)
          : financeConfigWithdrawnView(tx, staff, await rowAt(tx, id));
      }, options);
    },
  };
}
