import {
  AdminAdListQuerySchema,
  AdminAdFiltersSchema,
  AdAssignBodySchema,
  AdReturnBodySchema,
  AdVersionCreateBodySchema,
  AdVersionPushBodySchema,
  AdminAdRequestChangeBodySchema,
  AdEmptyBodySchema,
  AdTaskDetailSchema,
} from "@liyoxi/contract";
import type {
  AdminAdListQuery,
  AdminAdFilters,
  AdVersionCreateBody,
  AdVersionPushBody,
  AdminAdRequestChangeBody,
} from "@liyoxi/contract";
import {
  assignAdTx,
  returnAdTx,
  requestAdminAdChangeTx,
  readAdReopenFacts,
  assertAdStaff,
  assertCurrentAdStaff,
  adAdminTarget,
  adAdminVersionParent,
  listAdminAds,
  summaryAdminAds,
  detailAdminAd,
  adminVersionView,
  signAdminAdDetail,
  prelockAdminAdTx,
  registerAdminAdVersionTx,
  pushAdminAdVersionTx,
  markAdVersionSentTx,
  remindAdminAdTx,
} from "../ad/index.js";
import type { AdStaffActor, AdWriteDeps, AdAdminReadDeps } from "../ad/index.js";
import { readAdTaskStore } from "../profile/index.js";
import { readAdAgreementConsent } from "../docs/index.js";
import { readCancelHoldFacts, readAdPricingPlanName } from "../billing/index.js";
import {
  readAdPlacementDetails,
  readAdOrderReferences,
  readAdCancelCards,
} from "../order/index.js";
import {
  readAdTicketDetails,
  readAdDeliveryImpact,
  lockAdDeliveryImpact,
  applyAdDeliveryImpact,
} from "../delivery/index.js";
import type { DeliveryCoreDeps } from "../delivery/index.js";
import { readAdServiceTickets } from "../support/index.js";
import { staffBriefs } from "../staff/index.js";
import { AppError } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";

type Options = { idem?: IdempotencyContext };
/** Each use case owns one business transaction. Foreign aggregates expose only owner projections. */
export function createAdminAdRuntime(
  input: Omit<AdWriteDeps, "related">,
  delivery: DeliveryCoreDeps,
) {
  const deps: AdAdminReadDeps = {
    ...input,
    async related(tx, scope) {
      const placements = await readAdPlacementDetails(tx, scope);
      const tickets = await readAdTicketDetails(
        tx,
        placements.floatingPlacements.map((r) => r.orderItemId),
      );
      const people = await staffBriefs(
        tx,
        tickets.flatMap((r) => (r.managerId ? [r.managerId] : [])),
      );
      return {
        usage: placements.usage,
        floatingPlacements: placements.floatingPlacements.map((r) => {
          if (r.slot !== "opening" && r.slot !== "ending")
            throw new AppError("PRECONDITION_CHANGED");
          const ticket = tickets.find((t) => t.itemId === r.orderItemId);
          return {
            ...r,
            slot: r.slot,
            ticketStep: ticket?.step ?? null,
            isTicketPaused: ticket?.isPaused ?? false,
            serviceManagerName: people.find((p) => p.staffId === ticket?.managerId)?.name ?? null,
          };
        }),
        relatedServiceTickets: await readAdServiceTickets(tx, scope),
      };
    },
    async relations(tx, _actor, ad) {
      const scope = { entityId: ad.entityId, storeId: ad.storeId, adId: ad.id };
      const store = await readAdTaskStore(tx, scope);
      const hold = await readCancelHoldFacts(tx, ad.pointHoldId);
      if (
        !hold ||
        hold.refType !== "ad" ||
        hold.refId !== ad.id ||
        hold.entityId !== ad.entityId ||
        hold.storeId !== ad.storeId
      )
        throw new AppError("PRECONDITION_CHANGED");
      const placements = await readAdPlacementDetails(tx, scope);
      const tickets = await readAdTicketDetails(
        tx,
        placements.placements.map((r) => r.orderItemId),
      );
      return {
        ...store,
        planName: await readAdPricingPlanName(tx, ad.pricingSnapshot),
        pointHold: {
          pointHoldId: hold.id,
          status: hold.status,
          heldAt: hold.heldAt.toISOString(),
          capturedAt: hold.capturedAt?.toISOString() ?? null,
        },
        agreement: await readAdAgreementConsent(tx, {
          ...scope,
          agreementConsentId: ad.agreementConsentId,
        }),
        cancelRequests: await readAdCancelCards(tx, deps, scope),
        usages: AdTaskDetailSchema.shape.usages.parse(
          placements.placements.map((r) => {
            const ticket = tickets.find((t) => t.itemId === r.orderItemId);
            return {
              orderItemId: r.orderItemId,
              orderNo: r.orderNo,
              deliveryTicketId: ticket?.deliveryTicketId ?? null,
              ticketNo: ticket?.ticketNo ?? null,
              dramaTitle: r.dramaTitle,
              slot: r.slot,
              boundVersionNo: r.boundVersionNo,
              phase: r.phase,
            };
          }),
        ),
        serviceTickets: (await readAdServiceTickets(tx, scope)).map((r) => ({
          serviceTicketId: r.serviceTicketId,
          ticketNo: r.ticketNo,
          status: r.status,
        })),
      };
    },
  };
  const detail = (tx: Tx, actor: AdStaffActor, id: string) => detailAdminAd(tx, deps, actor, id);
  const preflight = (actor: AdStaffActor, target: { adId: string } | { versionId: string }) =>
    deps.tx.run(async (tx) => {
      // Authorization is outside the idempotency callback so a done receipt cannot bypass revocation.
      await assertCurrentAdStaff(tx, actor);
      if ("adId" in target) await adAdminTarget(tx, actor, target.adId);
      else await adAdminVersionParent(tx, actor, target.versionId);
    });
  const write = async (
    actor: AdStaffActor,
    options: Options,
    target: { adId: string } | { versionId: string },
    run: (tx: Tx) => Promise<string>,
  ) => {
    await preflight(actor, target);
    const value = await deps.tx.run(async (tx) => detail(tx, actor, await run(tx)), options);
    if (!options.idem?.replayed) await signAdminAdDetail(deps, value);
    return { ...value, replayed: options.idem?.replayed ?? false };
  };
  return {
    list(actor: AdStaffActor, query: AdminAdListQuery) {
      const q = AdminAdListQuerySchema.parse(query);
      return deps.tx.run((tx) => listAdminAds(tx, deps, actor, q));
    },
    summary(actor: AdStaffActor, query: AdminAdFilters) {
      const q = AdminAdFiltersSchema.parse(query);
      return deps.tx.run((tx) => summaryAdminAds(tx, deps, actor, q));
    },
    async get(actor: AdStaffActor, id: string) {
      return signAdminAdDetail(deps, await deps.tx.run((tx) => detail(tx, actor, id)));
    },
    assign(actor: AdStaffActor, id: string, inputBody: { staffId: string }, options: Options = {}) {
      const body = AdAssignBodySchema.parse(inputBody);
      assertAdStaff(actor, "delivery.ad.assign", true);
      return write(actor, options, { adId: id }, async (tx) => {
        await prelockAdminAdTx(tx, actor, id, [body.staffId]);
        await assignAdTx(tx, deps, actor, id, body.staffId);
        return id;
      });
    },
    return(actor: AdStaffActor, id: string, inputBody: { reason: string }, options: Options = {}) {
      const body = AdReturnBodySchema.parse(inputBody);
      assertAdStaff(actor, "delivery.ad.return", true);
      return write(actor, options, { adId: id }, async (tx) => {
        await prelockAdminAdTx(tx, actor, id);
        return returnAdTx(tx, deps, actor, id, body.reason);
      });
    },
    registerVersion(
      actor: AdStaffActor,
      id: string,
      inputBody: AdVersionCreateBody,
      options: Options = {},
    ) {
      const body = AdVersionCreateBodySchema.parse(inputBody);
      assertAdStaff(actor, "delivery.ad.upload", true);
      return write(
        actor,
        options,
        { adId: id },
        async (tx) => (await registerAdminAdVersionTx(tx, deps, actor, id, body)).adId,
      );
    },
    push(
      actor: AdStaffActor,
      versionId: string,
      inputBody: AdVersionPushBody,
      options: Options = {},
    ) {
      const body = AdVersionPushBodySchema.parse(inputBody);
      assertAdStaff(actor, "delivery.ad.upload", true);
      return write(
        actor,
        options,
        { versionId },
        async (tx) => (await pushAdminAdVersionTx(tx, deps, actor, versionId, body)).adId,
      );
    },
    async markSent(
      actor: AdStaffActor,
      versionId: string,
      body: Record<string, never>,
      options: Options = {},
    ) {
      AdEmptyBodySchema.parse(body);
      assertAdStaff(actor, "delivery.sample.push", true);
      await preflight(actor, { versionId });
      const result = await deps.tx.run(async (tx) => {
        await markAdVersionSentTx(tx, deps, actor, versionId);
        return adminVersionView(tx, deps, actor, versionId);
      }, options);
      if (!options.idem?.replayed) {
        const signed = await deps.media.signRead({ fileId: result.fileId, audience: "staff" });
        result.preview = { ...signed, posterUrl: null };
      }
      return { ...result, replayed: options.idem?.replayed ?? false };
    },
    requestChange(
      actor: AdStaffActor,
      id: string,
      inputBody: AdminAdRequestChangeBody,
      options: Options = {},
    ) {
      const body = AdminAdRequestChangeBodySchema.parse(inputBody);
      assertAdStaff(actor, "delivery.sample.feedback_on_behalf", true);
      return write(actor, options, { adId: id }, async (tx) => {
        const ad = await adAdminTarget(tx, actor, id),
          scope = { entityId: ad.entityId, storeId: ad.storeId, adId: id };
        const fact = await readAdReopenFacts(tx, scope);
        if (!fact) throw new AppError("NOT_FOUND");
        const impact = await readAdDeliveryImpact(
          tx,
          { ...scope, mode: "reopen" },
          readAdOrderReferences,
        );
        await lockAdDeliveryImpact(tx, impact, {
          staffIds: [actor.staff.staff.id],
          fileIds: [
            ...(body.screenshotFileIds ?? []),
            ...(fact.latestPushedVersion ? [fact.latestPushedVersion.fileId] : []),
          ],
        });
        await assertCurrentAdStaff(tx, actor);
        await adAdminTarget(tx, actor, id);
        await requestAdminAdChangeTx(tx, deps, actor, id, body);
        await applyAdDeliveryImpact(tx, delivery, actor.ctx, impact);
        return id;
      });
    },
    async remind(
      actor: AdStaffActor,
      id: string,
      body: Record<string, never>,
      options: Options = {},
    ) {
      AdEmptyBodySchema.parse(body);
      assertAdStaff(actor);
      await preflight(actor, { adId: id });
      return {
        ...(await deps.tx.run((tx) => remindAdminAdTx(tx, deps, actor, id), options)),
        replayed: options.idem?.replayed ?? false,
      };
    },
  };
}
