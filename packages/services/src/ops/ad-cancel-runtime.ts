import type { AdCancelQuoteBody, AdCancelRequestCreateBody } from "@liyoxi/contract";
import { AdCancelRequestCreateBodySchema } from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { IdempotencyContext } from "../kernel/index.js";
import { createAdCancel, quoteAdCancel, readCancelRequestDetail } from "../order/index.js";
import type { CancelActor, CancelDeps } from "../order/index.js";
import { createAdCancelApprovalRefCompanion } from "../support/index.js";

/** HTTP adaptation only: all money and approval writes stay in the existing cancellation owner. */
export function createAdCancelRequests(deps: CancelDeps) {
  const service = createAdCancel(deps);
  const staffOf = (actor: CancelActor) => {
    if (
      !actor.staff ||
      actor.ctx.actor.type !== "staff" ||
      actor.ctx.actor.id !== actor.staff.staff.id
    )
      throw new AppError("PERMISSION_DENIED");
    assertPermission(actor.staff, "order.refund.request", deps.clock.now());
    return actor.staff;
  };
  return {
    quote(actor: CancelActor, adId: string, body: AdCancelQuoteBody) {
      const staff = staffOf(actor);
      return deps.tx.run((tx) =>
        quoteAdCancel(tx, { scope: staff.scope, adId, body }, deps.clock.now()),
      );
    },
    async create(
      actor: CancelActor,
      adId: string,
      input: AdCancelRequestCreateBody,
      idem?: IdempotencyContext,
    ) {
      staffOf(actor);
      const { serviceTicketId, ...body } = AdCancelRequestCreateBodySchema.parse(input);
      const result = await service.submit(
        actor,
        adId,
        body,
        idem,
        serviceTicketId
          ? createAdCancelApprovalRefCompanion({ serviceTicketId, clock: deps.clock })
          : undefined,
      );
      return deps.tx.run((tx) => readCancelRequestDetail(tx, deps, actor, result.id));
    },
  };
}
