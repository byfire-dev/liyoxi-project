import type { AccountChangeCreateBody } from "@liyoxi/contract";
import { approvalKindPort, defineApprovalKind } from "../approval/index.js";
import { implementKeyed } from "../kernel/index.js";
import { sealPhone } from "../security/index.js";
import { accountChangeCall } from "./account-change-context.js";
import { checkIssue, precheck } from "./account-change-facts.js";
import {
  applyAccountChange,
  clearAccountChangeRequest,
  revalidateAccountChange,
} from "./account-change-apply.js";

export const accountChangeKind = implementKeyed(
  approvalKindPort,
  "account_change",
  defineApprovalKind<AccountChangeCreateBody>({
    category: "approval",
    domain: { table: "account_change_request", column: "approval_request_id" },
    viewModules: ["merchant"],
    decidePermission: "merchant.account_change.approve",
    groupBound: false,
    hasExecution: false,
    numberPrefix: "ZH",
    dedupeKey: (s) => `account_change:${s.input.kind}:${s.subjectId}`,
    operations: {
      get: "admin.accountChangeRequest.get",
      approve: "admin.accountChangeRequest.approve",
      reject: "admin.accountChangeRequest.reject",
      withdraw: "admin.accountChangeRequest.withdraw",
    },
    validate: async (tx, submission) => {
      const { deps } = accountChangeCall(tx);
      checkIssue(await precheck(tx, deps, submission.input), false);
    },
    summarize: async (tx, submission) => {
      const state = accountChangeCall(tx),
        facts = await precheck(tx, state.deps, submission.input);
      const labels = {
        phone_rebind: "换绑手机号",
        owner_transfer: "更换老板",
        owner_reverify: "老板身份复核",
      };
      return {
        title: labels[submission.input.kind],
        lines: [
          { label: "目标号码", value: facts.user?.phoneMask ?? "" },
          ...(submission.input.kind !== "owner_reverify"
            ? [
                {
                  label: "新号码",
                  value: sealPhone(
                    state.deps.keyring(),
                    "account_change_request.new_phone_enc",
                    submission.input.newPhone,
                  ).mask,
                },
              ]
            : []),
        ],
        domain: { type: "account_change_request", id: state.requestId },
      };
    },
    revalidate: revalidateAccountChange,
    onApproved: applyAccountChange,
    onRejected: clearAccountChangeRequest,
    onWithdrawn: clearAccountChangeRequest,
  }),
);
