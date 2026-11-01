import { AdRequestChangeBodySchema } from "@liyoxi/contract";
import type { AdConfirmBody, AdRequestChangeBody } from "@liyoxi/contract";
import {
  createAdService,
  confirmAdTx,
  requestChangeAdTx,
  reopenAdFreeTx,
  assignAdTx,
  registerAdVersionTx,
  pushAdVersionTx,
  returnAdTx,
  readAdReopenFacts,
  stateResult,
  revisionResult,
  assertAdMerchantAccess,
} from "../ad/index.js";
import type {
  AdActor,
  AdWriteDeps,
  AdStaffActor,
  AdFreeReopenInput,
  RegisterAdVersionInput,
} from "../ad/index.js";
import { AppError, createThreePhaseRunner } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";
import {
  readAdDeliveryImpact,
  lockAdDeliveryImpact,
  applyAdDeliveryImpact,
  readAdTicketDetails,
} from "../delivery/index.js";
import type { DeliveryCoreDeps } from "../delivery/index.js";
import { readAdOrderReferences, readAdPlacementDetails } from "../order/index.js";
import { readAdServiceTickets } from "../support/index.js";
import { staffBriefs } from "../staff/index.js";

/** Cross-owner effects stay in one business transaction, with all low-ranked targets known first. */
export function createAdRuntime(input: Omit<AdWriteDeps, "related">, delivery: DeliveryCoreDeps) {
  const deps: AdWriteDeps = {
    ...input,
    async related(tx, scope) {
      const placements = await readAdPlacementDetails(tx, scope);
      const tickets = await readAdTicketDetails(
        tx,
        placements.floatingPlacements.map((row) => row.orderItemId),
      );
      const staff = await staffBriefs(
        tx,
        tickets.flatMap((row) => (row.managerId ? [row.managerId] : [])),
      );
      return {
        usage: placements.usage,
        floatingPlacements: placements.floatingPlacements.map((row) => {
          const ticket = tickets.find((item) => item.itemId === row.orderItemId);
          return {
            ...row,
            slot: row.slot as "opening" | "ending",
            ticketStep: ticket?.step ?? null,
            isTicketPaused: ticket?.isPaused ?? false,
            serviceManagerName:
              staff.find((item) => item.staffId === ticket?.managerId)?.name ?? null,
          };
        }),
        relatedServiceTickets: await readAdServiceTickets(tx, scope),
      };
    },
  };
  const prepare = async (
    tx: Tx,
    actor: AdActor,
    adId: string,
    mode: "confirm" | "reopen",
    fileIds: readonly string[],
  ) => {
    await assertAdMerchantAccess(tx, actor);
    const scope = { entityId: actor.membership.entityId, storeId: actor.membership.storeId, adId };
    const fact = await readAdReopenFacts(tx, scope);
    if (!fact) throw new AppError("NOT_FOUND");
    const impact = await readAdDeliveryImpact(tx, { ...scope, mode }, readAdOrderReferences);
    await lockAdDeliveryImpact(tx, impact, {
      memberIds: [actor.membership.memberId],
      fileIds: [...fileIds, ...(fact.latestPushedVersion ? [fact.latestPushedVersion.fileId] : [])],
    });
    return impact;
  };
  return {
    ...createAdService(deps),
    confirm(
      actor: AdActor,
      adId: string,
      body: AdConfirmBody,
      options: { idem?: IdempotencyContext } = {},
    ) {
      return deps.tx.run(async (tx) => {
        const impact = await prepare(tx, actor, adId, "confirm", []);
        await confirmAdTx(tx, deps, actor, adId, body);
        await applyAdDeliveryImpact(tx, delivery, actor.ctx, impact);
        return stateResult(tx, deps, actor, adId);
      }, options);
    },
    async requestChange(
      actor: AdActor,
      adId: string,
      inputBody: AdRequestChangeBody,
      options: { idem?: IdempotencyContext } = {},
    ) {
      const body = AdRequestChangeBodySchema.parse(inputBody);
      return createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            await assertAdMerchantAccess(tx, actor);
            const current = await readAdReopenFacts(tx, {
              entityId: actor.membership.entityId,
              storeId: actor.membership.storeId,
              adId,
            });
            if (!current) throw new AppError("NOT_FOUND");
            if (current.openCancelRequestId) throw new AppError("AD_CANCEL_IN_PROGRESS");
            if (current.latestPushedVersion?.versionNo !== body.versionNo)
              throw new AppError("AD_VERSION_STALE", {
                details: { currentVersionNo: current.latestPushedVersion?.versionNo ?? null },
              });
          },
          external: () => deps.moderate(actor, { note: body.note }),
          settle: async (tx) => {
            const impact = await prepare(tx, actor, adId, "reopen", body.screenshotFileIds ?? []);
            const change = await requestChangeAdTx(tx, deps, actor, adId, body);
            await applyAdDeliveryImpact(tx, delivery, actor.ctx, impact);
            return revisionResult(tx, deps, actor, change);
          },
        },
        options,
      );
    },
    reopenFreeTx: (tx: Tx, actor: AdStaffActor, body: AdFreeReopenInput) =>
      reopenAdFreeTx(tx, deps, actor, body),
    // Shared producer cores for W5-09; no additional HTTP route or SLA consumer is installed here.
    production: {
      returnTx: (tx: Tx, actor: AdStaffActor, adId: string, reason: string) =>
        returnAdTx(tx, deps, actor, adId, reason),
      assignTx: (tx: Tx, actor: AdStaffActor, adId: string, editorId: string) =>
        assignAdTx(tx, deps, actor, adId, editorId),
      registerVersionTx: (
        tx: Tx,
        actor: AdStaffActor,
        adId: string,
        body: RegisterAdVersionInput,
      ) => registerAdVersionTx(tx, deps, actor, adId, body),
      pushVersionTx: (tx: Tx, actor: AdStaffActor, versionId: string) =>
        pushAdVersionTx(tx, deps, actor, versionId),
    },
  };
}
