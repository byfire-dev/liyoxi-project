import {
  z,
  AdminAssetDemandCreateBodySchema,
  AdminAssetDemandCancelBodySchema,
  AdminAssetDemandListQuerySchema,
  AdminAssetDemandRowSchema,
  AssetDemandListQuerySchema,
  AssetDemandItemSchema,
} from "@liyoxi/contract";
import type { Prisma, StoreAssetDemand } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { AppError, uuidv7, lockRows, createThreePhaseRunner } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { record } from "../../audit/index.js";
import type { MediaActor } from "../context.js";
import { assetActor, assetStore, assetScope } from "./repo.js";
import { parseAssetInput } from "./write.js";
import type { AssetDeps } from "./context.js";
import type { AssetWriteOptions } from "./types.js";

export function assetCursor(row: { id: string; createdAt: Date }) {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
}
export function assetCursorWhere(cursor?: string) {
  if (!cursor) return {};
  try {
    const [time, id] = z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return {
      OR: [{ createdAt: { lt: new Date(time) } }, { createdAt: new Date(time), id: { lt: id } }],
    };
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
}
export async function demandView(
  tx: Tx,
  deps: AssetDeps,
  actor: MediaActor,
  row: StoreAssetDemand,
) {
  const creator = await deps.assets.readUploader(tx, {
    entityId: row.entityId,
    actorType: "staff",
    actorId: row.createdByStaffId,
  });
  if (!creator.staff) throw new AppError("PROVIDER_UNAVAILABLE");
  const receivedCount = await tx.storeAsset.count({
    where: { storeAssetDemandId: row.id, deletedAt: null },
  });
  const common = {
    assetDemandId: row.id,
    title: row.title,
    shootingNote: row.shootingNote,
    dueDate: row.dueDate.toISOString().slice(0, 10),
    status: row.status,
    isOverdue:
      row.status === "open" &&
      row.dueDate.toISOString().slice(0, 10) < calendarDate(deps.clock.now()),
    receivedCount,
    createdAt: row.createdAt.toISOString(),
  };
  return actor.staff
    ? AdminAssetDemandRowSchema.parse({
        ...common,
        storeId: row.storeId,
        notifyScope: row.notifyScope,
        createdBy: creator.staff,
        closedAt: row.closedAt?.toISOString() ?? null,
        actions:
          row.status === "open" && actor.staff.permissions.has("merchant.asset.demand.create")
            ? ["complete", "cancel"]
            : [],
      })
    : AssetDemandItemSchema.parse({
        ...common,
        createdByName: creator.displayName ?? creator.staff.name,
        myUploadCount: await tx.storeAsset.count({
          where: {
            storeAssetDemandId: row.id,
            deletedAt: null,
            uploadActorType: "merchant",
            uploadActorId: actor.identity.actor.id,
          },
        }),
      });
}
async function demandForActor(tx: Tx, actor: MediaActor, id: string) {
  const row = await tx.storeAssetDemand.findFirst({ where: { id, ...assetScope(actor) } });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
async function demandAudit(
  tx: Tx,
  actor: MediaActor,
  row: StoreAssetDemand,
  action: string,
  reason?: string,
) {
  await record(
    tx,
    actor.identity.actor,
    actor.audit ?? {
      requestId: actor.identity.requestId,
      ip: null,
      userAgent: null,
      authMethod: null,
    },
    {
      stream: "activity",
      category: "profile_edit",
      action: `media.asset_demand.${action}`,
      target: { type: "store_asset_demand", id: row.id },
      entityId: row.entityId,
      storeId: row.storeId,
      summary: `素材需求：${action}`,
      ...(reason ? { reason: { code: action, text: reason } } : {}),
    },
  );
}
export function createAssetDemands(deps: AssetDeps) {
  return {
    async list(actor: MediaActor, value: unknown) {
      assetActor(actor, "read", deps.clock.now());
      if (!actor.staff) assetActor(actor, "demand", deps.clock.now());
      const input = parseAssetInput(
        actor.staff ? AdminAssetDemandListQuerySchema : AssetDemandListQuerySchema,
        value,
      );
      return deps.tx.run(async (tx) => {
        if (actor.staff)
          await assetStore(tx, deps, actor, "storeId" in input ? String(input.storeId) : "");
        const where: Prisma.StoreAssetDemandWhereInput = {
          ...assetScope(actor),
          ...("storeId" in input ? { storeId: String(input.storeId) } : {}),
          ...(input.status
            ? { status: { in: input.status.split(",") } }
            : actor.staff
              ? {}
              : { status: "open" }),
          ...(!actor.staff && actor.identity.actor.role === "clerk"
            ? { notifyScope: "owner_and_clerks" }
            : {}),
        };
        if ("page" in input) {
          const offset = (input.page - 1) * input.pageSize;
          const openWhere = { AND: [where, { status: "open" }] },
            openCount = await tx.storeAssetDemand.count({ where: openWhere });
          const rows =
            offset < openCount
              ? await tx.storeAssetDemand.findMany({
                  where: openWhere,
                  orderBy: [{ dueDate: "asc" }, { id: "asc" }],
                  skip: offset,
                  take: input.pageSize,
                })
              : [];
          if (rows.length < input.pageSize)
            rows.push(
              ...(await tx.storeAssetDemand.findMany({
                where: { AND: [where, { status: { not: "open" } }] },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                skip: Math.max(0, offset - openCount),
                take: input.pageSize - rows.length,
              })),
            );
          const items = [];
          for (const row of rows) items.push(await demandView(tx, deps, actor, row));
          return {
            items,
            total: await tx.storeAssetDemand.count({ where }),
            page: input.page,
            pageSize: input.pageSize,
          };
        }
        const rows = await tx.storeAssetDemand.findMany({
          where: { AND: [where, assetCursorWhere(input.cursor)] },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
        });
        const page = rows.slice(0, input.limit),
          items = [];
        for (const row of page) items.push(await demandView(tx, deps, actor, row));
        return {
          items,
          nextCursor: rows.length > input.limit ? assetCursor(page.at(-1)!) : null,
          hasMore: rows.length > input.limit,
        };
      });
    },
    async create(actor: MediaActor, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(AdminAssetDemandCreateBodySchema, value);
      assetActor(actor, "demand", deps.clock.now());
      if (!actor.staff) throw new AppError("ROLE_FORBIDDEN");
      const check = async (tx: Tx) => {
        if (input.dueDate < calendarDate(deps.clock.now())) throw new AppError("VALIDATION_FAILED");
        return assetStore(tx, deps, actor, input.storeId, true);
      };
      return createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            await check(tx);
          },
          external: () =>
            deps.assets.checkDemandText({ title: input.title, shootingNote: input.shootingNote }),
          settle: async (tx) => {
            await lockRows(tx, "store", [input.storeId]);
            const store = await check(tx),
              now = deps.clock.now();
            const row = await tx.storeAssetDemand.create({
              data: {
                id: uuidv7(),
                entityId: store.entityId,
                storeId: store.id,
                title: input.title,
                shootingNote: input.shootingNote ?? null,
                dueDate: new Date(`${input.dueDate}T00:00:00Z`),
                notifyScope: input.notifyScope,
                status: "open",
                createdByStaffId: actor.staff!.staff.id,
                createdAt: now,
                updatedAt: now,
              },
            });
            await demandAudit(tx, actor, row, "create");
            await deps.events.emit(tx, actor.identity, {
              type: "asset.demand_created",
              aggregate: { type: "store_asset_demand", id: row.id },
              entityId: row.entityId,
              storeId: row.storeId,
              payload: {
                v: 1,
                storeAssetDemandId: row.id,
                storeId: row.storeId,
                notifyScope: row.notifyScope,
                dueDate: input.dueDate,
              },
              dedupeKey: `asset.demand_created:${row.id}`,
            });
            return demandView(tx, deps, actor, row);
          },
        },
        options,
      );
    },
    async close(
      actor: MediaActor,
      id: string,
      action: "cancel" | "complete",
      value: unknown,
      options: AssetWriteOptions = {},
    ) {
      const input =
        action === "cancel"
          ? parseAssetInput(AdminAssetDemandCancelBodySchema, value)
          : parseAssetInput(z.strictObject({}), value);
      assetActor(actor, "demand", deps.clock.now());
      if (!actor.staff) throw new AppError("ROLE_FORBIDDEN");
      return deps.tx.run(async (tx) => {
        const before = await demandForActor(tx, actor, id);
        await lockRows(tx, "store", [before.storeId]);
        await assetStore(tx, deps, actor, before.storeId, true);
        const row = await demandForActor(tx, actor, id);
        if (row.status !== "open") throw new AppError("STATE_NOT_ALLOWED");
        const now = deps.clock.now();
        const updated = await tx.storeAssetDemand.update({
          where: { id },
          data: {
            status: action === "cancel" ? "canceled" : "done",
            closedAt: now,
            updatedAt: now,
          },
        });
        await demandAudit(
          tx,
          actor,
          row,
          action,
          "reasonText" in input ? String(input.reasonText ?? "") : undefined,
        );
        return demandView(tx, deps, actor, updated);
      }, options);
    },
  };
}
