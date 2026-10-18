import { DramaActivityResultSchema } from "@liyoxi/contract";
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
import {
  adminDramaDetail,
  copyrightRevisionView,
  adminTrailerView,
  adminMediaReadiness,
  adminEpisodeView,
  adminDramaEpisodes,
  adminPermitView,
  adminDramaPermits,
  adminDramas,
  adminDramaSummary,
} from "../content/index.js";
import type { ContentAdminReadDeps, ContentCopyright } from "../content/index.js";
import type { DramaPricingService } from "../billing/index.js";
import type { Media } from "../media/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx, TxRunOptions, TxRunner } from "../kernel/index.js";
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
    activity(tx: Tx, id: string, query: unknown): Promise<unknown>;
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
  const writeDrama = async (
    actor: ContentAdminActor,
    id: string | null,
    action: (tx: Tx) => Promise<string | void>,
    options: TxRunOptions,
    permission: Parameters<typeof assertAccess>[1]["permission"] = null,
  ) => {
    authorize(actor, permission === null, permission);
    const result = await deps.tx.run(async (tx) => {
      const created = await action(tx);
      const actual = id ?? created;
      if (!actual) throw new TypeError("content write omitted drama id");
      return { ...(await adminDramaDetail(tx, deps, actor.staff, actual)), replayed: false };
    }, options);
    const replayed = Boolean(options.idem?.replayed);
    return { ...(await decorate(result, replayed)), replayed };
  };
  return {
    async list(staff: StaffContext, query: unknown) {
      assertAccess(staff, { module: { module: "drama", need: "view" }, permission: null });
      const result = await deps.tx.run((tx) => adminDramas(tx, deps, staff, query));
      const posters = await deps.tx.run((tx) =>
        tx.drama.findMany({
          where: { id: { in: result.items.map((v) => v.dramaId) } },
          select: { id: true, posterFileId: true },
        }),
      );
      for (const item of result.items) {
        const file = posters.find((v) => v.id === item.dramaId)?.posterFileId;
        if (file) {
          try {
            item.posterUrl = await deps.media.signRead({ fileId: file });
          } catch (error) {
            if (!(
              error instanceof AppError &&
              ["PROVIDER_UNAVAILABLE", "FILE_NOT_AVAILABLE"].includes(error.error)
            ))
              throw error;
          }
        }
      }
      return result;
    },
    summary(staff: StaffContext, query: unknown) {
      assertAccess(staff, { module: { module: "drama", need: "view" }, permission: null });
      return deps.tx.run((tx) => adminDramaSummary(tx, deps, query));
    },
    async get(actor: ContentAdminActor, id: string) {
      authorize(actor, false);
      return decorate(
        await deps.tx.run((tx) => adminDramaDetail(tx, deps, actor.staff, id)),
        false,
      );
    },
    activities(actor: ContentAdminActor, id: string, query: unknown) {
      authorize(actor, false);
      return deps.tx.run(async (tx) => {
        if (!(await tx.drama.findUnique({ where: { id }, select: { id: true } })))
          throw new AppError("NOT_FOUND");
        return DramaActivityResultSchema.parse(await deps.activity(tx, id, query));
      });
    },
    listingChecks(actor: ContentAdminActor, id: string) {
      authorize(actor, false);
      return deps.tx.run((tx) => deps.content.listingChecks(tx, id));
    },
    async mediaReadiness(actor: ContentAdminActor, id: string) {
      authorize(actor, false);
      const result = await deps.tx.run((tx) => adminMediaReadiness(tx, deps, id));
      if (result.trailer) {
        const detail = await deps.tx.run((tx) => adminDramaDetail(tx, deps, actor.staff, id));
        result.trailer = (await decorate(detail, false)).trailer;
      }
      return result;
    },
    episodes(actor: ContentAdminActor, id: string, query: unknown) {
      authorize(actor, false);
      return deps.tx.run((tx) => adminDramaEpisodes(tx, deps, id, query));
    },
    permits(actor: ContentAdminActor, id: string, query: unknown) {
      authorize(actor, false);
      return deps.tx.run((tx) => adminDramaPermits(tx, deps, actor.staff, id, query));
    },
    create(actor: ContentAdminActor, body: { title: string }, options: TxRunOptions = {}) {
      return writeDrama(
        actor,
        null,
        async (tx) => (await deps.content.createDraft(tx, actor.identity, body)).id,
        options,
      );
    },
    basic(
      actor: ContentAdminActor,
      id: string,
      body: Parameters<ContentAdminReadDeps["content"]["saveBasic"]>[3],
      options: TxRunOptions = {},
    ) {
      return writeDrama(
        actor,
        id,
        async (tx) => {
          await deps.content.saveBasic(tx, actor.identity, id, body);
        },
        options,
      );
    },
    commercial(
      actor: ContentAdminActor,
      id: string,
      body: Parameters<ContentAdminReadDeps["content"]["saveCommercial"]>[3],
      options: TxRunOptions = {},
    ) {
      return writeDrama(
        actor,
        id,
        async (tx) => {
          await deps.content.saveCommercial(tx, actor.identity, id, body);
        },
        options,
      );
    },
    cast(
      actor: ContentAdminActor,
      id: string,
      body: Parameters<ContentAdminReadDeps["content"]["saveRoles"]>[3],
      options: TxRunOptions = {},
    ) {
      return writeDrama(
        actor,
        id,
        async (tx) => {
          await deps.content.saveRoles(tx, actor.identity, id, body);
        },
        options,
      );
    },
    shelve(actor: ContentAdminActor, id: string, options: TxRunOptions = {}) {
      return writeDrama(
        actor,
        id,
        async (tx) => {
          await deps.content.list(tx, actor.identity, id);
        },
        options,
        "drama.shelf",
      );
    },
    delist(actor: ContentAdminActor, id: string, body: unknown, options: TxRunOptions = {}) {
      return writeDrama(
        actor,
        id,
        async (tx) => {
          await deps.content.delist(tx, actor.identity, id, body);
        },
        options,
        "drama.shelf",
      );
    },
    async createPermit(
      actor: ContentAdminActor,
      id: string,
      body: Parameters<ContentAdminReadDeps["content"]["createPermit"]>[3],
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      return deps.tx.run(async (tx) => {
        const permit = await deps.content.createPermit(tx, actor.identity, id, body);
        const retired = "replacesDramaPermitId" in body ? body.replacesDramaPermitId : null;
        return {
          permit: await adminPermitView(tx, deps, actor.staff, permit.id),
          retiredPermit: retired ? await adminPermitView(tx, deps, actor.staff, retired) : null,
          dramaLockVersion: (
            await tx.drama.findUniqueOrThrow({ where: { id }, select: { lockVersion: true } })
          ).lockVersion,
        };
      }, options);
    },
    async updatePermit(
      actor: ContentAdminActor,
      id: string,
      body: Parameters<ContentAdminReadDeps["content"]["updatePermit"]>[3],
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      return deps.tx.run(async (tx) => {
        const permit = await deps.content.updatePermit(tx, actor.identity, id, body);
        return {
          permit: await adminPermitView(tx, deps, actor.staff, id),
          dramaLockVersion: (
            await tx.drama.findUniqueOrThrow({
              where: { id: permit.dramaId },
              select: { lockVersion: true },
            })
          ).lockVersion,
        };
      }, options);
    },
    async retirePermit(
      actor: ContentAdminActor,
      id: string,
      body: unknown,
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      return deps.tx.run(async (tx) => {
        const permit = await deps.content.retirePermit(tx, actor.identity, id, body);
        return {
          permit: await adminPermitView(tx, deps, actor.staff, id),
          dramaLockVersion: (
            await tx.drama.findUniqueOrThrow({
              where: { id: permit.dramaId },
              select: { lockVersion: true },
            })
          ).lockVersion,
        };
      }, options);
    },
    async updateEpisode(
      actor: ContentAdminActor,
      id: string,
      body: unknown,
      options: TxRunOptions = {},
    ) {
      authorize(actor);
      return deps.tx.run(async (tx) => {
        const episode = await deps.content.updateEpisode(tx, actor.identity, id, body);
        return {
          episode: await adminEpisodeView(tx, deps, id),
          dramaLockVersion: (
            await tx.drama.findUniqueOrThrow({
              where: { id: episode.dramaId },
              select: { lockVersion: true },
            })
          ).lockVersion,
        };
      }, options);
    },
    async trailer(
      actor: ContentAdminActor,
      id: string,
      body: { sourceFileId: string },
      options: TxRunOptions = {},
    ) {
      authorize(actor, false, "drama.media.manage");
      const result = await deps.tx.run(async (tx) => {
        await deps.content.replaceTrailer(tx, actor.identity, id, body.sourceFileId);
        const trailer = await adminTrailerView(tx, deps, id);
        if (!trailer) throw new TypeError("successful trailer write has no target");
        return { ...trailer, replayed: false };
      }, options);
      const replayed = Boolean(options.idem?.replayed);
      if (!replayed) {
        const detail = await deps.tx.run((tx) => adminDramaDetail(tx, deps, actor.staff, id));
        result.coverUrl = (await decorate(detail, false)).trailer?.coverUrl ?? null;
      }
      return { ...result, replayed };
    },
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
