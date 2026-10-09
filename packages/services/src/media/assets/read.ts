import {
  AdminStoreAssetListQuerySchema,
  AdminStoreAssetSummaryQuerySchema,
  AdminStoreAssetSummarySchema,
  StoreAssetListQuerySchema,
  StoreAssetSummaryQuerySchema,
  StoreAssetSummarySchema,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { AppError } from "../../kernel/index.js";
import type { MediaActor } from "../context.js";
import { createSigner } from "../read.js";
import { assetActor, assetOf, assetScope, assetStore } from "./repo.js";
import { assetView, attachAssetUrls } from "./views.js";
import { assetCursor, assetCursorWhere } from "./demands.js";
import { parseAssetInput } from "./write.js";
import type { AssetDeps } from "./context.js";

interface Filters {
  storeId?: string;
  status?: string;
  tag?: string;
  q?: string;
  uploader?: "me";
  isSelectableAsReference?: boolean;
  assetDemandId?: string;
  type?: string;
  usability?: string;
  hasPortraitAuthFiles?: boolean;
}
function displayFilter(value: string): Prisma.StoreAssetWhereInput {
  if (value === "organizing")
    return { OR: [{ processingState: { not: "processed" } }, { reviewState: "unreviewed" }] };
  const ready = { processingState: "processed", reviewState: "reviewed" };
  return value === "adopted"
    ? { ...ready, adoptedCount: { gt: 0 } }
    : { ...ready, adoptedCount: 0, usability: value };
}
export function assetWhere(actor: MediaActor, input: Filters): Prisma.StoreAssetWhereInput {
  const and: Prisma.StoreAssetWhereInput[] = [
    { deletedAt: null, ...assetScope(actor), ...(input.storeId ? { storeId: input.storeId } : {}) },
  ];
  if (input.status) and.push({ OR: input.status.split(",").map(displayFilter) });
  if (input.tag) and.push({ storeAssetTags: { some: { tagCode: { in: input.tag.split(",") } } } });
  if (input.q) and.push({ searchText: { contains: input.q, mode: "insensitive" } });
  if (input.uploader)
    and.push({
      uploadActorType: actor.identity.actor.type,
      uploadActorId: actor.identity.actor.id,
    });
  if (input.assetDemandId) and.push({ storeAssetDemandId: input.assetDemandId });
  if (input.type) and.push({ type: { in: input.type.split(",") } });
  if (input.usability) and.push({ usability: { in: input.usability.split(",") } });
  if (input.hasPortraitAuthFiles !== undefined)
    and.push({ portraitAuthFileIds: { isEmpty: !input.hasPortraitAuthFiles } });
  if (input.isSelectableAsReference !== undefined) {
    const selectable: Prisma.StoreAssetWhereInput = {
      moderationState: { not: "block" },
      OR: [{ usability: null }, { usability: { not: "need_reshoot" } }],
    };
    and.push(input.isSelectableAsReference ? selectable : { NOT: selectable });
  }
  return { AND: and };
}
export function createAssetReads(deps: AssetDeps) {
  const signer = createSigner(deps),
    decorate = <T extends { storeAssetId: string; thumbnail: unknown }>(
      actor: MediaActor,
      raw: T,
    ) => attachAssetUrls(deps, actor, raw, async (input) => (await signer(input)).signed);
  return {
    async get(actor: MediaActor, id: string) {
      assetActor(actor, "read", deps.clock.now());
      const raw = await deps.tx.run(async (tx) =>
        assetView(tx, deps, actor, await assetOf(tx, actor, id), true),
      );
      return decorate(actor, raw);
    },
    async list(actor: MediaActor, value: unknown) {
      assetActor(actor, "read", deps.clock.now());
      const input = parseAssetInput(
        actor.staff ? AdminStoreAssetListQuerySchema : StoreAssetListQuerySchema,
        value,
      );
      const raw = await deps.tx.run(async (tx) => {
        if ("storeId" in input && input.storeId) await assetStore(tx, deps, actor, input.storeId);
        const where = assetWhere(actor, input),
          and: Prisma.StoreAssetWhereInput[] = [where];
        if ("ids" in input && input.ids) {
          const ids = input.ids.split(","),
            rows = await tx.storeAsset.findMany({ where: { AND: [where, { id: { in: ids } }] } });
          const items = [];
          for (const id of ids) {
            const row = rows.find((row) => row.id === id);
            if (row) items.push(await assetView(tx, deps, actor, row, false));
          }
          return { items, nextCursor: null, hasMore: false };
        }
        if ("tab" in input && input.tab && input.tab !== "all")
          and.push(
            actor.staff
              ? input.tab === "organizing"
                ? { reviewState: "unreviewed" }
                : { adoptedCount: { gt: 0 } }
              : { type: input.tab },
          );
        if ("page" in input) {
          const orderBy: Prisma.StoreAssetOrderByWithRelationInput[] =
            input.sort === "reviewDueAt"
              ? [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }]
              : [{ createdAt: "desc" }, { id: "desc" }];
          const rows = await tx.storeAsset.findMany({
            where: { AND: and },
            orderBy,
            skip: (input.page - 1) * input.pageSize,
            take: input.pageSize,
          });
          const items = [];
          for (const row of rows) items.push(await assetView(tx, deps, actor, row, false));
          return {
            items,
            total: await tx.storeAsset.count({ where: { AND: and } }),
            page: input.page,
            pageSize: input.pageSize,
          };
        }
        and.push(assetCursorWhere(input.cursor));
        const rows = await tx.storeAsset.findMany({
          where: { AND: and },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
        });
        const items = [],
          page = rows.slice(0, input.limit);
        for (const row of page) items.push(await assetView(tx, deps, actor, row, false));
        return {
          items,
          nextCursor: rows.length > input.limit ? assetCursor(page.at(-1)!) : null,
          hasMore: rows.length > input.limit,
        };
      });
      const items = [];
      for (const row of raw.items) items.push(await decorate(actor, row));
      return { ...raw, items };
    },
    async summary(actor: MediaActor, value: unknown) {
      assetActor(actor, "read", deps.clock.now());
      const input = parseAssetInput(
        actor.staff ? AdminStoreAssetSummaryQuerySchema : StoreAssetSummaryQuerySchema,
        value,
      );
      return deps.tx.run(async (tx) => {
        if ("storeId" in input && input.storeId) await assetStore(tx, deps, actor, input.storeId);
        const where = assetWhere(actor, input),
          count = (filter: Prisma.StoreAssetWhereInput = {}) =>
            tx.storeAsset.count({ where: { AND: [where, filter] } });
        const all = await count(),
          types = { image: 0, video: 0, recording: 0, audio: 0, document: 0, text: 0 };
        for (const key of Object.keys(types) as (keyof typeof types)[])
          types[key] = await count({ type: key });
        const organizing = await count({ reviewState: "unreviewed" }),
          adopted = await count({ adoptedCount: { gt: 0 } });
        if (actor.staff)
          return AdminStoreAssetSummarySchema.parse({
            tabs: { all, organizing, adopted },
            organizedCount: await count({ reviewState: "reviewed" }),
            types,
            awaitingPortraitConfirmCount: await count({
              usability: "need_portrait_auth",
              portraitAuthFileIds: { isEmpty: false },
              portraitAuthorizedAt: null,
            }),
            reviewOverdueCount: await count({
              reviewState: "unreviewed",
              dueAt: { lt: deps.clock.now() },
            }),
          });
        const tags = await tx.storeAssetTag.groupBy({
          by: ["tagCode", "dimension", "storeAssetId"],
          where: { storeAsset: where },
        });
        const hot = new Map<string, { tagCode: string; dimension: string; assetCount: number }>();
        for (const row of tags) {
          const key = `${row.dimension}:${row.tagCode}`,
            old = hot.get(key);
          hot.set(key, {
            tagCode: row.tagCode,
            dimension: row.dimension,
            assetCount: (old?.assetCount ?? 0) + 1,
          });
        }
        const dictionary = await tx.dictItem.findMany({
          where: {
            dictTypeKey: "asset_tag",
            code: { in: [...hot.values()].map((row) => row.tagCode) },
          },
        });
        return StoreAssetSummarySchema.parse({
          tabs: { all, ...types },
          organizingCount: await count(displayFilter("organizing")),
          adoptedCount: adopted,
          recent7dCount: await count({
            createdAt: { gte: new Date(deps.clock.now().getTime() - 7 * 86400000) },
          }),
          hotTags: [...hot.values()]
            .sort((a, b) => b.assetCount - a.assetCount || a.tagCode.localeCompare(b.tagCode))
            .slice(0, 5)
            .map((row) => {
              const item = dictionary.find((item) => item.code === row.tagCode);
              if (!item) throw new AppError("VALIDATION_FAILED");
              return {
                dimension: row.dimension,
                tag: { code: item.code, name: item.name },
                assetCount: row.assetCount,
              };
            }),
        });
      });
    },
  };
}
