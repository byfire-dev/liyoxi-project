import type { PrismaClient } from "@liyoxi/db";
import type { PurchaseRule } from "@liyoxi/shared/purchase-policy";
import { proposeFinanceConfig } from "../billing/index.js";
import { createIdentityContext } from "../kernel/index.js";
import type { Runtime } from "../runtime.js";
import { createFactories, TEST_KEYRING } from "./data/index.js";
import { sampleStaffContext } from "./approval.js";
/** 每个策略都由两个真实不同员工提议/批准；不直接改批准后冻结的财务payload。 */
export async function installSitePurchasePolicy(
  db: PrismaClient,
  runtime: Pick<Runtime, "tx" | "clock" | "approval">,
  rules: PurchaseRule[],
) {
  const make = createFactories({ db, clock: runtime.clock }),
    proposer = await make.staff({ staffRoleKey: "super_admin" }),
    approver = await make.staff({ staffRoleKey: "super_admin" });
  const staff = await sampleStaffContext(db, proposer.id, { stepUpAt: runtime.clock.now() }),
    approveStaff = await sampleStaffContext(db, approver.id, { stepUpAt: runtime.clock.now() });
  const ctx = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  const created = await runtime.tx.run((tx) =>
    proposeFinanceConfig(
      tx,
      { approval: runtime.approval, clock: runtime.clock, keyring: TEST_KEYRING },
      ctx(proposer.id),
      { configKey: "purchase_policy", payload: { rules }, changeNote: "隔离站点购买策略验证" },
      staff,
    ),
  );
  await runtime.tx.run((tx) =>
    runtime.approval.approve(tx, ctx(approver.id), {
      approvalId: created.approvalId,
      staff: approveStaff,
      lockVersion: 0,
    }),
  );
  return created.financeConfigRevisionId;
}
