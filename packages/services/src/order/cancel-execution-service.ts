import type { CancelExecuteBody } from "@liyoxi/contract";
import type { IdempotencyContext } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";
import { assertPermission } from "../authz/index.js";
import { executeCancel } from "./ad-cancel.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { readExecutedCancelDetail } from "./cancel-execution-view.js";
import { runCancelUseCase } from "./cancel-use-case.js";
import { readCancelExecutionRequest } from "./cancel-execution.js";

/** Full response is built inside the same Tx and becomes the C50 replay result. */
export function createCancelExecution(deps: CancelDeps) {
  return {
    execute: (
      actor: CancelActor,
      id: string,
      input: CancelExecuteBody,
      idem?: IdempotencyContext,
    ) => {
      // C50 resolves before its transaction callback, so current authorization/scope
      // must be checked independently even when the complete response is cached.
      const precheck = deps.tx.run(async (tx) => {
        if (
          actor.ctx.actor.type !== "staff" ||
          !actor.staff ||
          actor.ctx.actor.id !== actor.staff.staff.id
        )
          throw new AppError("PERMISSION_DENIED");
        assertPermission(actor.staff, "finance.refund.execute", deps.clock.now());
        const current = await tx.staff.findUnique({
          where: { id: actor.staff.staff.id },
          select: { status: true, staffRoleKey: true, staffGroupId: true, isLead: true },
        });
        if (
          !current ||
          current.status !== "active" ||
          current.staffRoleKey !== actor.staff.staff.roleKey ||
          current.staffGroupId !== actor.staff.staff.staffGroupId ||
          current.isLead !== actor.staff.staff.isLead
        )
          throw new AppError("PERMISSION_DENIED");
        await readCancelExecutionRequest(tx, actor, id);
      });
      return precheck.then(() =>
        runCancelUseCase(
          deps,
          async (tx) => {
            await executeCancel(tx, deps, actor, id, input);
            return readExecutedCancelDetail(tx, deps, actor, id);
          },
          idem,
        ),
      );
    },
  };
}
export type CancelExecution = ReturnType<typeof createCancelExecution>;
