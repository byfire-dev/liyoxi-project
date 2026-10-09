import type {
  CopyrightReplaceBody,
  CopyrightRevisionCreateBody,
  DramaPriceCreateBody,
  DramaPriceListQuery,
  DramaPriceRevisionListQuery,
  AdminDramaDetail,
} from "@liyoxi/contract";
import { assertAccess } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { adminDramaDetail, copyrightRevisionView } from "../content/index.js";
import type { ContentAdminReadDeps, ContentCopyright } from "../content/index.js";
import type { DramaPricingService } from "../billing/index.js";
import type { Media } from "../media/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, TxRunOptions, TxRunner } from "../kernel/index.js";
export interface ContentAdminActor {
  staff: StaffContext;
  identity: IdentityContext;
}
export function createContentAdmin(
  deps: ContentAdminReadDeps & {
    tx: TxRunner;
    copyright: ContentCopyright;
    pricingService: DramaPricingService;
    media: Pick<Media, "signRead">;
  },
) {
  const authorize = (
    actor: ContentAdminActor,
    edit = true,
    permission: Parameters<typeof assertAccess>[1]["permission"] = null,
  ) => {
    assertAccess(actor.staff, {
      module: { module: "drama", need: edit ? "edit" : "view" },
      permission,
    });
    if (
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== actor.staff.staff.id ||
      actor.identity.entityId !== null ||
      actor.identity.storeId !== null
    )
      throw new AppError("PERMISSION_DENIED");
  };
  const decorate = async (detail: AdminDramaDetail, replayed: boolean) => {
    if (replayed) return detail;
    const sign = async (id: string | null) => {
      if (!id) return null;
      try {
        return await deps.media.signRead({ fileId: id });
      } catch (error) {
        if (
          error instanceof AppError &&
          ["PROVIDER_UNAVAILABLE", "FILE_NOT_AVAILABLE"].includes(error.error)
        )
          return null;
        throw error;
      }
    };
    detail.posterUrl = await sign(detail.posterFileId);
    if (detail.trailer) {
      const fileId = await deps.tx.run(
        async (tx) =>
          (
            await tx.playableAsset.findUnique({
              where: { id: detail.trailer!.targetPlayableId },
              select: { coverFileId: true },
            })
          )?.coverFileId ?? null,
      );
      detail.trailer.coverUrl = await sign(fileId);
    }
    return detail;
  };
  return {
    async replace(
      actor: ContentAdminActor,
      id: string,
      body: CopyrightReplaceBody,
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      const result = await deps.tx.run(async (tx) => {
        await deps.copyright.replace(tx, actor.identity, id, body);
        return { ...(await adminDramaDetail(tx, deps, actor.staff, id)), replayed: false };
      }, options);
      const replayed = Boolean(options.idem?.replayed);
      return { ...(await decorate(result, replayed)), replayed };
    },
    async revise(
      actor: ContentAdminActor,
      id: string,
      body: CopyrightRevisionCreateBody,
      options: TxRunOptions = {},
    ) {
      authorize(actor, false, "drama.copyright.revise");
      const result = await deps.tx.run(async (tx) => {
        const revisionId = await deps.copyright.revise(tx, actor.identity, id, body);
        return {
          revision: await copyrightRevisionView(tx, deps, revisionId),
          drama: await adminDramaDetail(tx, deps, actor.staff, id),
          replayed: false,
        };
      }, options);
      const replayed = Boolean(options.idem?.replayed);
      return { ...result, drama: await decorate(result.drama, replayed), replayed };
    },
    async confirmPermit(
      actor: ContentAdminActor,
      id: string,
      body: unknown,
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      const result = await deps.tx.run(async (tx) => {
        await deps.copyright.confirmPermit(tx, actor.identity, id, body);
        return { ...(await adminDramaDetail(tx, deps, actor.staff, id)), replayed: false };
      }, options);
      const replayed = Boolean(options.idem?.replayed);
      return { ...(await decorate(result, replayed)), replayed };
    },
    listPrices: (staff: StaffContext, query: DramaPriceListQuery) =>
      deps.tx.run((tx) => deps.pricingService.list(tx, staff, query)),
    priceSummary: (staff: StaffContext) =>
      deps.tx.run((tx) => deps.pricingService.summary(tx, staff)),
    priceRevisions: (staff: StaffContext, query: DramaPriceRevisionListQuery) =>
      deps.tx.run((tx) => deps.pricingService.revisions(tx, staff, query)),
    priceTiers: (staff: StaffContext) => deps.tx.run((tx) => deps.pricingService.tiers(tx, staff)),
    createPrice: (
      actor: ContentAdminActor,
      id: string,
      body: DramaPriceCreateBody,
      options: TxRunOptions = {},
    ) =>
      deps.tx.run(
        (tx) => deps.pricingService.create(tx, actor.staff, actor.identity, id, body),
        options,
      ),
    withdrawPrice: (
      actor: ContentAdminActor,
      id: string,
      body: unknown,
      options: TxRunOptions = {},
    ) =>
      deps.tx.run(
        (tx) => deps.pricingService.withdraw(tx, actor.staff, actor.identity, id, body),
        options,
      ),
  };
}
export type ContentAdmin = ReturnType<typeof createContentAdmin>;
