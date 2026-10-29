import { OrderCancelQuoteBodySchema } from "@liyoxi/contract";
import type {
  CancelApproveBody,
  CancelRejectBody,
  CancelVoidBody,
  CancelWithdrawBody,
  OrderCancelQuoteBody,
  OrderCancelRequestCreateBody,
} from "@liyoxi/contract";
import { assertPermission, assertStepUp, satisfiesLevel } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { cancelScope } from "./cancel-context.js";
import {
  approveCancelRequest,
  rejectCancelRequest,
  withdrawCancelRequest,
  voidCancelRequest,
} from "./cancel-decisions.js";
import { readCancelExecutionRequest } from "./cancel-execution.js";
import { cancelStaff, checkCancelStaff } from "./cancel-identity.js";
import { quoteOrderCancel } from "./cancel-quote.js";
import { scopedCancelOrder } from "./cancel-request-locks.js";
import { readCancelRequestDetail } from "./cancel-read.js";
import { createOrderCancelRequest } from "./cancel-submit.js";
import { runCancelUseCase } from "./cancel-use-case.js";

export async function quoteOrderCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  orderId: string,
  input: OrderCancelQuoteBody,
) {
  const staff = await checkCancelStaff(tx, actor);
  assertPermission(staff, "order.refund.request", deps.clock.now());
  return quoteOrderCancel(
    tx,
    { scope: staff.scope, orderId, body: OrderCancelQuoteBodySchema.parse(input) },
    deps.clock.now(),
  );
}

/** Read current authorization/scope before C50's cached result can bypass its callback. */
export function createCancelRequests(deps: CancelDeps) {
  async function precheck(
    actor: CancelActor,
    id: string,
    action: "create" | "approve" | "reject" | "withdraw" | "void",
  ) {
    await deps.tx.run(async (tx) => {
      const staff = await checkCancelStaff(tx, actor);
      if (
        !satisfiesLevel(staff.moduleLevels.order, "view") &&
        !satisfiesLevel(staff.moduleLevels.finance, "view")
      )
        throw new AppError("PERMISSION_DENIED");
      if (action === "create") {
        assertPermission(staff, "order.refund.request", deps.clock.now());
        await scopedCancelOrder(tx, cancelScope(actor), id);
      } else {
        const r = await readCancelExecutionRequest(tx, actor, id, {
          allowRequester: action === "withdraw" || action === "void",
        });
        if (action === "approve" || action === "reject")
          assertPermission(staff, "finance.refund.approve", deps.clock.now(), {
            skipStepUp: action === "reject",
          });
        if (action === "void") {
          assertPermission(staff, "order.refund.request", deps.clock.now());
          if (staff.staff.id !== r.approvalRequest.requesterStaffId) {
            throw new AppError("PERMISSION_DENIED");
          }
        }
        if (
          action === "withdraw" &&
          cancelStaff(actor).staff.id !== r.approvalRequest.requesterStaffId
        )
          assertStepUp(staff, "finance.refund.approve", deps.clock.now());
      }
    });
  }
  const run = async (
    actor: CancelActor,
    id: string,
    action: Parameters<typeof precheck>[2],
    fn: (tx: Tx) => Promise<string>,
    idem?: IdempotencyContext,
  ) => {
    await precheck(actor, id, action);
    return runCancelUseCase(
      deps,
      async (tx) => readCancelRequestDetail(tx, deps, actor, await fn(tx)),
      idem,
    );
  };
  return {
    quote: (actor: CancelActor, orderId: string, body: OrderCancelQuoteBody) =>
      deps.tx.run((tx) => quoteOrderCancelRequest(tx, deps, actor, orderId, body)),
    create: (
      actor: CancelActor,
      orderId: string,
      body: OrderCancelRequestCreateBody,
      idem?: IdempotencyContext,
    ) =>
      run(
        actor,
        orderId,
        "create",
        (tx) => createOrderCancelRequest(tx, deps, actor, orderId, body, idem?.key),
        idem,
      ),
    approve: (actor: CancelActor, id: string, body: CancelApproveBody, idem?: IdempotencyContext) =>
      run(actor, id, "approve", (tx) => approveCancelRequest(tx, deps, actor, id, body), idem),
    reject: (actor: CancelActor, id: string, body: CancelRejectBody, idem?: IdempotencyContext) =>
      run(actor, id, "reject", (tx) => rejectCancelRequest(tx, deps, actor, id, body), idem),
    withdraw: (
      actor: CancelActor,
      id: string,
      body: CancelWithdrawBody,
      idem?: IdempotencyContext,
    ) => run(actor, id, "withdraw", (tx) => withdrawCancelRequest(tx, deps, actor, id, body), idem),
    void: (actor: CancelActor, id: string, body: CancelVoidBody, idem?: IdempotencyContext) =>
      run(actor, id, "void", (tx) => voidCancelRequest(tx, deps, actor, id, body), idem),
  };
}
export type CancelRequests = ReturnType<typeof createCancelRequests>;
export { createOrderCancelRequest } from "./cancel-submit.js";
export {
  approveCancelRequest,
  rejectCancelRequest,
  withdrawCancelRequest,
  voidCancelRequest,
} from "./cancel-decisions.js";
