import type { AccessSnapshot } from "../../../lib/permissions";
import type { ConfigRevision } from "./types";
export const id = "0199e187-e72a-7000-8000-000000000001",
  requester = "0199e187-e72a-7000-8000-000000000002",
  reviewer = "0199e187-e72a-7000-8000-000000000003",
  approvalId = "0199e187-e72a-7000-8000-000000000004";
export const access: AccessSnapshot = {
  staff: { id: reviewer, name: "虚构财务审批人", roleKey: "finance", roleName: "财务" },
  moduleLevels: { finance: "e" },
  dataScope: "all",
  isLead: false,
  actions: ["finance.config.approve", "finance.config.propose"],
  releases: {},
};
export function bank(): ConfigRevision {
  return {
    financeConfigRevisionId: id,
    configKey: "bank_account",
    payload: { accountName: "虚构测试账户", bankName: "虚构银行", accountNoMask: "****4321" },
    changeNote: "虚构测试变更",
    effectiveAt: null,
    state: "pending",
    createdAt: "2030-10-18T04:00:00.000Z",
    approval: {
      approvalId,
      kind: "finance_config_change",
      status: "pending",
      roundNo: 1,
      submittedAt: "2030-10-18T04:00:00.000Z",
      dueAt: null,
      badges: [],
      requester: {
        staffId: requester,
        staffNo: 1002,
        name: "虚构提议人",
        roleKey: "finance",
        status: "active",
        isLead: false,
      },
      decidedBy: null,
      isDecidedBySystem: false,
      decidedAt: null,
      decisionNote: null,
      reasons: [],
      lockVersion: 7,
      actions: ["approve", "reject"],
    },
    actions: ["approve", "reject"],
  };
}
