// W1-11b：正常提议与双人审批写入占位配置。注入过去时钟，不倒拨运行器。
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { createApproval } from "../approval/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type {
  Assembly,
  BizNoIssuer,
  Clock,
  SeedTableResult,
  TxRunner,
  Tx,
} from "../kernel/index.js";
import type { Keyring } from "../security/index.js";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { FINANCE_CONFIG_KEYS, proposeFinanceConfig } from "./finance-config/index.js";

export const PLACEHOLDER_FINANCE = {
  bank_account: {
    accountName: "狸有戏（演示收款户，勿转账）",
    bankName: "演示银行",
    accountNo: "0000000000000000",
  },
  purchase_policy: { rules: [] },
  controls: DEFAULT_CONTROLS,
} as const;
export interface BillingSeedDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  bizNo: BizNoIssuer;
  keyring: Keyring;
}
async function financeStaff(tx: Tx, id: string, at: Date) {
  const staff = await tx.staff.findUniqueOrThrow({ where: { id } });
  if (
    staff.status !== "active" ||
    staff.staffRoleKey !== "finance" ||
    !isStaffRoleKey(staff.staffRoleKey)
  )
    throw new AppError("PRECONDITION_CHANGED", {
      message: "演示财务必须是在职财务员工；种子不会覆盖员工状态",
    });
  const role = await tx.staffRole.findUniqueOrThrow({ where: { key: staff.staffRoleKey } });
  const group = staff.staffGroupId
    ? await tx.staff.findMany({
        where: { staffGroupId: staff.staffGroupId, status: "active" },
        select: { id: true },
      })
    : [];
  return buildStaffContext({
    staff: {
      id,
      roleKey: staff.staffRoleKey,
      isLead: staff.isLead,
      staffGroupId: staff.staffGroupId,
    },
    role: normalizeRoleConfig(staff.staffRoleKey, role),
    groupStaffIds: group.map((s) => s.id),
    stepUpAt: at,
  });
}
export async function seedPlaceholderFinanceConfig(
  deps: BillingSeedDeps,
  staffIds: { proposerId: string; approverId: string },
): Promise<readonly SeedTableResult[]> {
  if (staffIds.proposerId === staffIds.approverId) throw new AppError("APPROVAL_SELF_FORBIDDEN");
  const at = new Date(deps.clock.now().getTime() - 25 * 3_600_000),
    clock: Clock = { now: () => new Date(at) };
  const events = createEvents({ assembly: deps.assembly, clock, tx: deps.tx });
  const flow = createFlow({ assembly: deps.assembly, clock, events });
  const approval = createApproval({
    assembly: deps.assembly,
    clock,
    flow,
    events,
    bizNo: deps.bizNo,
  });
  let inserted = 0,
    existing = 0;
  for (const configKey of FINANCE_CONFIG_KEYS) {
    const added = await deps.tx.run(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('lyx:seed:demo:billing'))");
      await lockRows(tx, "staff", [staffIds.proposerId, staffIds.approverId], "share");
      const proposer = await financeStaff(tx, staffIds.proposerId, at),
        approver = await financeStaff(tx, staffIds.approverId, at);
      const found = await tx.financeConfigRevision.findFirst({ where: { configKey } });
      if (found) return false;
      const ctx = (id: string) =>
        createIdentityContext({ actor: { type: "staff", id, client: "cli" } });
      const created = await proposeFinanceConfig(
        tx,
        { approval, clock, keyring: deps.keyring },
        ctx(proposer.staff.id),
        {
          configKey,
          payload: PLACEHOLDER_FINANCE[configKey],
          changeNote: "演示占位配置；不可用于真实转账",
        },
        proposer,
      );
      await approval.approve(tx, ctx(approver.staff.id), {
        approvalId: created.approvalId,
        staff: approver,
        lockVersion: 0,
        meta: {
          requestId: null,
          ip: null,
          userAgent: null,
          authMethod: null,
          sessionId: null,
          jobName: "cli.db.seed.demo.billing",
        },
      });
      return true;
    });
    if (added) inserted++;
    else existing++;
  }
  return [{ table: "finance_config_revision", inserted, existing }];
}
