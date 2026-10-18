import {
  PointPackCreateBodySchema,
  PointPackUpdateBodySchema,
  PointPackRowSchema,
  PointPackSummarySchema,
  PointPackCardSchema,
} from "@liyoxi/contract";
import type {
  PointPackAdminQuery,
  PointPackCreateBody,
  PointPackUpdateBody,
  PurchasePolicy,
} from "@liyoxi/contract";
import type { PointPack } from "@liyoxi/db";
import { calendarDate, startOfDay } from "@liyoxi/shared/time";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { assertAccess, assertCapability, hasPermission, standingOf } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, IdempotencyContext, Tx } from "../../kernel/index.js";
import type { BillingPurchaseDeps, PurchaseActor } from "../payment/purchase-context.js";
import type { PurchaseClient } from "../policy/index.js";
import { getPurchasePolicy } from "../policy/index.js";
import { getEntitlements } from "../read/index.js";

type Deps = Pick<BillingPurchaseDeps, "tx" | "clock" | "tenant" | "config" | "wechatPay">;
export interface PointPackActor {
  identity: IdentityContext;
  staff: StaffContext;
}
export async function assertTopupActor(tx: Tx, deps: Pick<Deps, "tenant">, actor: PurchaseActor) {
  if (
    actor.ctx.actor.type !== "merchant" ||
    !actor.ctx.actor.id ||
    actor.ctx.actor.role !== "owner" ||
    actor.membership.role !== "owner" ||
    actor.ctx.entityId !== actor.membership.entityId
  )
    throw new AppError("ROLE_FORBIDDEN");
  const current = await deps.tenant.resolveMembership(tx, {
    merchantUserId: actor.ctx.actor.id,
    storeId: actor.membership.storeId,
  });
  if (!current || current.entityId !== actor.membership.entityId) throw new AppError("NOT_FOUND");
  assertCapability(standingOf(current.role, current.storeMode), "points.topup");
}
/** 锁后取现价；履约从此快照取值，绝不再读可变档位。 */
export async function quotePointPack(
  tx: Tx,
  entityId: string,
  id: string,
  at: Date,
  policy: (type: string, amount: number) => Promise<PurchasePolicy>,
) {
  const e = await getEntitlements(tx, entityId, at);
  if (e.refundPending) throw new AppError("PLAN_REFUND_IN_PROGRESS");
  if (e.subStatus !== "active") throw new AppError("TOPUP_REQUIRES_ACTIVE_PLAN");
  const pack = await tx.pointPack.findUnique({ where: { id } });
  if (!pack) throw new AppError("NOT_FOUND");
  if (!pack.isListed) throw new AppError("PLAN_NOT_AVAILABLE");
  const p = await policy("topup", pack.priceFen);
  if (p.mode !== "in_app")
    throw new AppError("PURCHASE_NOT_OFFERED", { details: { mode: p.mode } });
  return {
    pack,
    policy: p,
    content: {
      v: 1 as const,
      kind: "topup" as const,
      packId: pack.id,
      points: pack.points,
      payFen: pack.priceFen,
    },
  };
}
function monthAt(at: Date, offset = 0) {
  const [y, m] = calendarDate(at).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + offset, 1)).toISOString().slice(0, 7);
}
const monthStart = (month: string) => startOfDay(`${month}-01`);
async function sales(tx: Tx, at: Date) {
  return tx.$queryRaw<{ id: string; count: number; fen: bigint }[]>`
    SELECT content_snapshot->>'packId' AS id, count(*)::integer AS count,
      COALESCE(sum(paid_amount_fen),0)::bigint AS fen FROM billing_order
    WHERE type='topup' AND status IN ('paid','refunded')
      AND paid_at >= ${monthStart(monthAt(at))} AND paid_at < ${monthStart(monthAt(at, 1))}
    GROUP BY content_snapshot->>'packId'`;
}
export function createPointPacks(deps: Deps) {
  function read(staff: StaffContext) {
    assertAccess(staff, { module: { module: "billing", need: "view" }, permission: null });
  }
  function write(actor: PointPackActor) {
    assertAccess(actor.staff, {
      module: { module: "billing", need: "view" },
      permission: "billing.pack.edit",
    });
    if (
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== actor.staff.staff.id ||
      actor.identity.entityId !== null ||
      actor.identity.storeId !== null
    )
      throw new AppError("PERMISSION_DENIED");
  }
  async function row(
    tx: Tx,
    pack: PointPack,
    staff: StaffContext,
    at: Date,
    sold?: Awaited<ReturnType<typeof sales>>,
  ) {
    const counts = (sold ?? (await sales(tx, at))).find((r) => r.id === pack.id);
    return PointPackRowSchema.parse({
      pointPackId: pack.id,
      points: pack.points,
      priceFen: pack.priceFen,
      isListed: pack.isListed,
      position: pack.position,
      soldThisMonthCount: counts?.count ?? 0,
      soldThisMonthFen: (counts?.fen ?? 0n).toString(),
      lockVersion: pack.lockVersion,
      updatedAt: pack.updatedAt.toISOString(),
      actions: hasPermission(staff, "billing.pack.edit")
        ? ["update", pack.isListed ? "delist" : "shelve"]
        : [],
    });
  }
  async function lock(tx: Tx, id?: string) {
    // 全局目录自身串行化；不与计费账户共锁，不新增全局锁序项。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('billing.point_pack_catalog',0))`;
    if (!id) return null;
    await tx.$queryRaw`SELECT id FROM point_pack WHERE id=${id}::uuid FOR UPDATE`;
    const current = await tx.pointPack.findUnique({ where: { id } });
    if (!current) throw new AppError("NOT_FOUND");
    return current;
  }
  async function unique(tx: Tx, points: number, id?: string) {
    if (
      await tx.pointPack.findFirst({
        where: { isListed: true, points, ...(id ? { id: { not: id } } : {}) },
      })
    )
      throw new AppError("POINT_PACK_DUPLICATE");
  }
  async function audit(
    tx: Tx,
    actor: PointPackActor,
    kind: "create" | "update" | "shelve" | "delist",
    before: PointPack | null,
    after: PointPack,
  ) {
    await record(
      tx,
      actor.identity.actor,
      {
        requestId: actor.identity.requestId,
        ip: actor.identity.ip,
        userAgent: actor.identity.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "activity",
        category: "plan_config",
        action: `billing.point_pack.${kind}`,
        summary: {
          create: "新增积分包",
          update: "编辑积分包",
          shelve: "上架积分包",
          delist: "下架积分包",
        }[kind],
        target: { type: "point_pack", id: after.id },
        before,
        after,
        fields: ["points", "priceFen", "position", "isListed", "lockVersion"],
      },
    );
  }
  const changeListing = (
    actor: PointPackActor,
    id: string,
    isListed: boolean,
    options: { idem?: IdempotencyContext },
  ) => {
    write(actor);
    return deps.tx.run(async (tx) => {
      const before = (await lock(tx, id))!;
      if (before.isListed === isListed) throw new AppError("STATE_NOT_ALLOWED");
      if (isListed) await unique(tx, before.points, id);
      const after = await tx.pointPack.update({
        where: { id },
        data: { isListed, lockVersion: { increment: 1 }, updatedAt: deps.clock.now() },
      });
      await audit(tx, actor, isListed ? "shelve" : "delist", before, after);
      return row(tx, after, actor.staff, deps.clock.now());
    }, options);
  };
  return {
    listMerchant: (actor: PurchaseActor, client: PurchaseClient) =>
      deps.tx.run(async (tx) => {
        await assertTopupActor(tx, deps, actor);
        const p = await getPurchasePolicy(
          tx,
          deps.config,
          actor.membership.entityId,
          deps.clock.now(),
          client,
          "topup",
          undefined,
          deps.wechatPay?.provider.configured ?? false,
        );
        if (p.mode !== "in_app") return { items: [] };
        const packs = await tx.pointPack.findMany({
          where: { isListed: true },
          orderBy: [{ position: "asc" }, { points: "asc" }, { id: "asc" }],
        });
        return {
          items: packs.map((pack) =>
            PointPackCardSchema.parse({
              pointPackId: pack.id,
              points: pack.points,
              priceFen: p.isPriceShown ? pack.priceFen : null,
            }),
          ),
        };
      }),
    listAdmin: (staff: StaffContext, query: PointPackAdminQuery) => {
      read(staff);
      return deps.tx.run(async (tx) => {
        const at = deps.clock.now(),
          sold = await sales(tx, at);
        const packs = await tx.pointPack.findMany({
          where: query.isListed === undefined ? {} : { isListed: query.isListed },
          orderBy: [{ position: "asc" }, { points: "asc" }, { id: "asc" }],
        });
        return { items: await Promise.all(packs.map((pack) => row(tx, pack, staff, at, sold))) };
      });
    },
    summary: (staff: StaffContext) => {
      read(staff);
      return deps.tx.run(async (tx) => {
        const at = deps.clock.now(),
          month = monthAt(at),
          from = monthStart(month),
          until = monthStart(monthAt(at, 1));
        const [totals] = await tx.$queryRaw<
          { count: number; fen: bigint; entities: number; allEntities: number }[]
        >`
          SELECT count(*) FILTER(WHERE type='topup')::integer AS count,
            COALESCE(sum(paid_amount_fen) FILTER(WHERE type='topup'),0)::bigint AS fen,
            count(DISTINCT entity_id) FILTER(WHERE type='topup')::integer AS entities,
            count(DISTINCT entity_id)::integer AS "allEntities" FROM billing_order
          WHERE status IN ('paid','refunded') AND paid_at>=${from} AND paid_at<${until}`;
        const inflow = await tx.$queryRaw<{ month: string; points: bigint }[]>`
          SELECT to_char(e.biz_date,'YYYY-MM') AS month, sum(e.qty)::bigint AS points
          FROM point_ledger_entry e JOIN point_lot l ON l.id=e.point_lot_id
          WHERE e.from_bucket='external' AND e.to_bucket='available' AND l.source_type='purchase'
            AND e.biz_date>=${new Date(`${monthAt(at, -5)}-01T00:00:00.000Z`)} AND e.biz_date<${new Date(`${monthAt(at, 1)}-01T00:00:00.000Z`)}
          GROUP BY to_char(e.biz_date,'YYYY-MM')`;
        return PointPackSummarySchema.parse({
          month,
          topupCount: totals!.count,
          topupFen: totals!.fen.toString(),
          topupEntityCount: totals!.entities,
          topupRateBp: totals!.allEntities
            ? divRoundHalfUp([totals!.entities, 10000], [totals!.allEntities])
            : null,
          monthly: Array.from({ length: 6 }, (_, i) => {
            const m = monthAt(at, i - 5);
            return {
              month: m,
              points: Number(inflow.find((r) => r.month === m)?.points ?? 0n),
              isCurrent: m === month,
            };
          }),
        });
      });
    },
    create: (
      actor: PointPackActor,
      input: PointPackCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      write(actor);
      const body = PointPackCreateBodySchema.safeParse(input);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        await lock(tx);
        await unique(tx, body.data.points);
        const max = await tx.pointPack.aggregate({ _max: { position: true } }),
          at = deps.clock.now();
        const position = body.data.position ?? (max._max.position ?? -1) + 1;
        if (!Number.isSafeInteger(position) || position > 2147483647)
          throw new AppError("VALIDATION_FAILED");
        const pack = await tx.pointPack.create({
          data: {
            ...body.data,
            position,
            id: uuidv7(),
            isListed: true,
            createdAt: at,
            updatedAt: at,
          },
        });
        await audit(tx, actor, "create", null, pack);
        return row(tx, pack, actor.staff, at);
      }, options);
    },
    update: (
      actor: PointPackActor,
      id: string,
      input: PointPackUpdateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      write(actor);
      const body = PointPackUpdateBodySchema.safeParse(input);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        const before = (await lock(tx, id))!;
        if (before.lockVersion !== body.data.lockVersion) throw new AppError("VERSION_CONFLICT");
        if (before.isListed) await unique(tx, body.data.points ?? before.points, id);
        const { lockVersion: _version, ...changes } = body.data;
        const at = deps.clock.now(),
          after = await tx.pointPack.update({
            where: { id },
            data: { ...changes, lockVersion: { increment: 1 }, updatedAt: at },
          });
        await audit(tx, actor, "update", before, after);
        return row(tx, after, actor.staff, at);
      }, options);
    },
    shelve: (actor: PointPackActor, id: string, options: { idem?: IdempotencyContext } = {}) =>
      changeListing(actor, id, true, options),
    delist: (actor: PointPackActor, id: string, options: { idem?: IdempotencyContext } = {}) =>
      changeListing(actor, id, false, options),
  };
}
