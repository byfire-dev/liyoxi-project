// approval.recordExecuted（W1-06）：有执行步的四类，领域行进入 done 时由领域用例在执行的那个事务里调。
// 依据：03 分组 第 2.12 节；x01 第 3.3 节 approval.executed。审批单停在 approved，这不是迁移：不写状态历史与审计，只发事件。
// 执行与决定分开：执行失败本模块什么都不写，审批结论不变；执行成功恰发一条（去重键 approval.executed:{审批单 id}）。
import type { ApprovalExecutionKind } from "@liyoxi/contract";

import type { EmitContext } from "../events/index.js";
import type { Tx } from "../kernel/index.js";

import { loadApproval } from "./context.js";
import type { ApprovalDeps } from "./context.js";
import { ApprovalError } from "./errors.js";

export interface RecordExecutedInput {
  readonly approvalId: string;
  /** 领域行：表名与 id */
  readonly domain: { readonly type: "cancel_request" | "refund_request"; readonly id: string };
}

/** 返回这次是否真的发了事件：同一张审批单已经发过即 false */
export async function recordExecuted(
  tx: Tx,
  deps: ApprovalDeps,
  ctx: EmitContext,
  input: RecordExecutedInput,
): Promise<{ emitted: boolean }> {
  const { row, kind } = await loadApproval(tx, deps, input.approvalId);
  if (!kind.hasExecution) {
    throw new ApprovalError("execution", `${row.kind} 没有执行步，通过即生效，不记执行`);
  }
  if (row.status !== "approved") {
    throw new ApprovalError("execution", `审批单是 ${row.status}，没有通过的不能记执行`);
  }
  const { emitted } = await deps.events.emit(tx, ctx, {
    type: "approval.executed",
    aggregate: { type: "approval_request", id: row.id },
    payload: {
      v: 1,
      approvalRequestId: row.id,
      kind: row.kind as ApprovalExecutionKind,
      domainType: input.domain.type,
      domainId: input.domain.id,
    },
    dedupeKey: `approval.executed:${row.id}`,
    entityId: row.entityId,
    storeId: row.storeId,
  });
  return { emitted };
}
