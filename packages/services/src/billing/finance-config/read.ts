import { FinanceConfigViewSchema } from "@liyoxi/contract";
import type { FinanceConfigListQuery } from "@liyoxi/contract";
import type { FinanceConfigRevision } from "@liyoxi/db";
import { satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { Approval } from "../../approval/index.js";
import { dictRef, staffBrief } from "../payment/purchase-read.js";
import { FINANCE_CONFIG_KEYS } from "./index.js";
import { currentFinanceConfig, financeConfigActivationDelaySeconds } from "./activation-policy.js";
export function assertFinanceView(staff: StaffContext) {
  if (!satisfiesLevel(staff.moduleLevels.finance, "view")) throw new AppError("PERMISSION_DENIED");
}
export async function financeConfigView(
  tx: Tx,
  approval: Approval,
  staff: StaffContext,
  row: FinanceConfigRevision,
  now: Date,
) {
  const info = await approval.decisionView(tx, staff, row.approvalRequestId);
  const current =
    info.status === "approved" ? await currentFinanceConfig(tx, row.configKey, now) : null;
  const currentDecision = current?.approvalRequest.decidedAt?.getTime(),
    rowDecision = info.decidedAt ? new Date(info.decidedAt).getTime() : undefined,
    superseded =
      current !== null &&
      current.id !== row.id &&
      currentDecision !== undefined &&
      rowDecision !== undefined &&
      (currentDecision > rowDecision || (currentDecision === rowDecision && current.id > row.id));
  const state =
    info.status === "pending"
      ? "pending"
      : info.status === "rejected"
        ? "rejected"
        : info.status === "withdrawn"
          ? "withdrawn"
          : superseded
            ? "superseded"
            : row.effectiveAt && row.effectiveAt > now
              ? "scheduled"
              : current?.id === row.id
                ? "effective"
                : "superseded";
  return FinanceConfigViewSchema.parse({
    financeConfigRevisionId: row.id,
    configKey: row.configKey,
    payload: row.payload,
    changeNote: row.changeNote,
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    activationDelaySeconds: financeConfigActivationDelaySeconds(row.configKey, row.payload),
    state,
    createdAt: row.createdAt.toISOString(),
    approval: info,
    actions: info.actions,
  });
}
/** Only the already-authorized requester's withdrawal response; not a finance read grant. */
export async function financeConfigWithdrawnView(
  tx: Tx,
  staff: StaffContext,
  row: FinanceConfigRevision,
) {
  const a = await tx.approvalRequest.findUniqueOrThrow({ where: { id: row.approvalRequestId } });
  if (
    a.requesterStaffId !== staff.staff.id ||
    a.status !== "withdrawn" ||
    a.kind !== "finance_config_change" ||
    a.subjectType !== "finance_config_revision" ||
    a.subjectId !== row.id
  )
    throw new AppError("PRECONDITION_CHANGED");
  return FinanceConfigViewSchema.parse({
    financeConfigRevisionId: row.id,
    configKey: row.configKey,
    payload: row.payload,
    changeNote: row.changeNote,
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    activationDelaySeconds: financeConfigActivationDelaySeconds(row.configKey, row.payload),
    state: "withdrawn",
    createdAt: row.createdAt.toISOString(),
    approval: {
      approvalId: a.id,
      kind: a.kind,
      status: a.status,
      roundNo: a.roundNo,
      submittedAt: a.submittedAt.toISOString(),
      dueAt: a.dueAt?.toISOString() ?? null,
      badges: [],
      requester: await staffBrief(tx, a.requesterStaffId),
      decidedBy: await staffBrief(tx, a.decidedByStaffId),
      isDecidedBySystem: a.isDecidedBySystem,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      decisionNote: a.decisionNote,
      reasons: await Promise.all(a.reasonCodes.map((code) => dictRef(tx, "reject_reason", code))),
      lockVersion: a.lockVersion,
      actions: [],
    },
    actions: [],
  });
}
export async function listFinanceConfigs(
  tx: Tx,
  approval: Approval,
  staff: StaffContext,
  query: FinanceConfigListQuery,
  now: Date,
) {
  assertFinanceView(staff);
  const where = {
    ...(query.configKey ? { configKey: query.configKey } : {}),
    ...(query.financeConfigRevisionId ? { id: query.financeConfigRevisionId } : {}),
  };
  if (query.tab === "history") {
    const rows = await tx.financeConfigRevision.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      items: await Promise.all(rows.map((r) => financeConfigView(tx, approval, staff, r, now))),
      page: query.page,
      pageSize: query.pageSize,
      total: await tx.financeConfigRevision.count({ where }),
    };
  }
  const selected: FinanceConfigRevision[] = [];
  for (const configKey of query.configKey ? [query.configKey] : FINANCE_CONFIG_KEYS) {
    const current = await currentFinanceConfig(tx, configKey, now);
    if (current) selected.push(current);
    selected.push(
      ...(await tx.financeConfigRevision.findMany({
        where: {
          configKey,
          OR: [
            { approvalRequest: { status: "pending" } },
            { effectiveAt: { gt: now }, approvalRequest: { status: "approved" } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })),
    );
  }
  return {
    items: (
      await Promise.all(selected.map((r) => financeConfigView(tx, approval, staff, r, now)))
    ).filter((row) => row.state !== "superseded"),
  };
}
