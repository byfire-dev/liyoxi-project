import { FinanceConfigCreateBodySchema } from "@liyoxi/contract";
import { createIdentityContext, isAppError } from "../../kernel/index.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixture } from "./context.js";

/** 隔离环境的真实配置提议；不直接填审批状态，不推进时钟模拟账户已生效。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const { runId } = assertDeliveryLiveEnvironment(runtime.env);
  if (runtime.providers.storage.status !== "fake") throw new Error("W418配置只接受隔离替身环境");
  const actors = await runtime.tx.run(async (tx) => ({
    proposer: await tx.staff.findFirstOrThrow({
      where: { name: "演练财务配置提议", staffRoleKey: "finance", status: "active" },
    }),
    approver: await tx.staff.findFirstOrThrow({
      where: { name: "演练财务配置审批", staffRoleKey: "finance", status: "active" },
    }),
  }));
  const staff = (id: string) =>
    runtime.tx.run((tx) => sampleStaffContext(tx, id, { stepUpAt: runtime.clock.now() }));
  const proposer = await staff(actors.proposer.id),
    service = runtime.billing.financeConfig,
    current = await service.list(proposer, {
      tab: "current",
      configKey: "bank_account",
      page: 1,
      pageSize: 20,
    }),
    baseline = current.items.find((row) => row.state === "effective");
  if (!baseline) throw new Error("W418配置缺少本轮真实生效账户");
  const identity = createIdentityContext({
      actor: { type: "staff", id: actors.proposer.id, client: "admin" },
    }),
    changeNote = `W418配置演练${runId.slice(0, 8)}`,
    proposed = await service.create(
      identity,
      proposer,
      FinanceConfigCreateBodySchema.parse({
        configKey: "bank_account",
        payload: {
          accountName: "本轮虚构配置收款主体",
          bankName: "本轮虚构配置银行",
          accountNo: "6222000012344321",
        },
        changeNote,
        confirm: { configKey: "bank_account", baseRevisionId: baseline.financeConfigRevisionId },
      }),
    );
  let selfApprovalRejected = false;
  try {
    await service.approve(identity, proposer, proposed.financeConfigRevisionId, {
      lockVersion: proposed.approval.lockVersion,
      confirmChecks: ["change_reviewed"],
      confirm: {
        configKey: "bank_account",
        financeConfigRevisionId: proposed.financeConfigRevisionId,
        accountNoLast4: "4321",
      },
    });
  } catch (error) {
    if (!isAppError(error) || error.error !== "APPROVAL_SELF_FORBIDDEN") throw error;
    selfApprovalRejected = true;
  }
  const after = await service.list(await staff(actors.approver.id), {
    tab: "history",
    financeConfigRevisionId: proposed.financeConfigRevisionId,
    page: 1,
    pageSize: 20,
  });
  if (
    !selfApprovalRejected ||
    after.items.length !== 1 ||
    after.items[0]?.state !== "pending" ||
    after.items[0].approval.lockVersion !== proposed.approval.lockVersion ||
    !after.items[0].actions.includes("approve")
  )
    throw new Error("W418配置实际自审守卫或异人动作前置未满足");
  const entities = [
    await make.merchant({ verified: true }),
    await make.merchant({ verified: true }),
  ];
  return {
    bankId: proposed.financeConfigRevisionId,
    approvalId: proposed.approval.approvalId,
    requesterStaffId: actors.proposer.id,
    baselineBankId: baseline.financeConfigRevisionId,
    changeNote,
    last4: "4321",
    selfApprovalRejected,
    entityIds: entities.map((entity) => entity.entity.id),
  };
};
export default fixture;
