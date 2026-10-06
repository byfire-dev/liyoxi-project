import { CartItemSchema } from "@liyoxi/contract";
import type { CartItem } from "@liyoxi/contract";
import { quoteDramaItem } from "@liyoxi/shared/pricing";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import { getEntitlements, getWalletView, paramsAt } from "../billing/index.js";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderActor, OrderDeps } from "./context.js";
import { dictRefs } from "./quote.js";
export const CART_LIMIT = 50;
// 09:72 的门店级事务咨询锁；不属于业务行锁序、不提前锁账本账户。
export async function lockCart(tx: Tx, storeId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cart:${storeId}`}, 0))`;
}
export async function cartItems(
  tx: Tx,
  deps: OrderDeps,
  actor: OrderActor,
  at: Date,
  newDays: number | null,
  onlyId?: string,
) {
  const { storeId, entityId } = actor.membership,
    rows = await tx.cartItem.findMany({
      where: { storeId, entityId, ...(onlyId ? { id: onlyId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    ids = rows.map((r) => r.dramaId),
    cards = await deps.content.getDramaCards(tx, ids, at),
    ability = await deps.content.getOrderability(tx, ids, calendarDate(at)),
    entitlements = await getEntitlements(tx, entityId, at),
    wallet = await getWalletView(tx, entityId, at),
    params = await paramsAt(tx, at),
    term = entitlements.subStatus === "active" ? entitlements.term : null;
  const items: CartItem[] = [];
  for (const row of rows) {
    const drama = cards.find((d) => d.id === row.dramaId);
    if (!drama) throw new Error("cart_item 的剧目外键失效");
    const valid = ability.get(row.dramaId)?.orderable === true && drama.listPricePoints !== null,
      state = !valid
        ? "invalid"
        : row.listPricePoints !== drama.listPricePoints
          ? "price_changed"
          : "valid",
      discounted =
        valid && term
          ? quoteDramaItem({
              listPricePoints: drama.listPricePoints!,
              discountBp: term.discountBp,
              topModelSurchargeBp: params.topModelSurchargeBp,
              isTopModelIncluded: term.productionModel === "top",
              isTopModelSelected: false,
            }).chargePoints
          : null;
    items.push(
      CartItemSchema.parse({
        cartItemId: row.id,
        drama: {
          dramaId: drama.id,
          title: drama.title,
          posterUrl: null,
          genres: await dictRefs(tx, "genre", drama.genreCodes),
          totalEpisodes: drama.totalEpisodes ?? 0,
          heatTier: drama.heatTier,
          badge:
            drama.firstListedAt &&
            newDays !== null &&
            diffDays(calendarDate(at), calendarDate(drama.firstListedAt)) < newDays
              ? "new"
              : drama.heatTier === "S"
                ? "hot"
                : null,
          listPricePoints: drama.listPricePoints,
          discountedPoints: discounted,
          usableUntilDate: drama.licenseEndDate,
        },
        state,
        invalidReason: valid ? null : (ability.get(row.dramaId)?.reason ?? "not_listed"),
        snapshotPricePoints: row.listPricePoints,
        currentPricePoints: drama.listPricePoints,
        discountedPoints: discounted,
        addedAt: row.createdAt.toISOString(),
        priceAckedAt: row.priceAckedAt?.toISOString() ?? null,
        actions: state === "price_changed" ? ["accept-price", "delete"] : ["delete"],
      }),
    );
  }
  return {
    items,
    limit: CART_LIMIT as 50,
    plan: term ? { planName: wallet.subscription.plan!.name, discountBp: term.discountBp } : null,
    spendablePoints: wallet.points.spendablePoints,
  };
}
async function currentPrice(tx: Tx, deps: OrderDeps, id: string, at: Date, creating: boolean) {
  const row = (await deps.content.getDramaCards(tx, [id], at))[0];
  if (!row || (creating && (row.status === "draft" || row.archivedAt)))
    throw new AppError("NOT_FOUND");
  const ability = (await deps.content.getOrderability(tx, [id], calendarDate(at))).get(id);
  if (!ability?.orderable || row.listPricePoints === null)
    throw new AppError("DRAMA_NOT_ORDERABLE", {
      details: { dramaId: id, reason: ability?.reason ?? "not_listed" },
    });
  return row.listPricePoints;
}
export async function addCart(
  tx: Tx,
  deps: OrderDeps,
  actor: OrderActor,
  dramaId: string,
  at: Date,
  newDays: number | null,
) {
  const { storeId, entityId } = actor.membership;
  await lockCart(tx, storeId);
  // 天然幂等先于剧目守卫与上限：已有项保留加入时 P，即使调价、失效或已达 50 部。
  const existing = await tx.cartItem.findUnique({
    where: { storeId_dramaId: { storeId, dramaId } },
  });
  if (existing) return (await cartItems(tx, deps, actor, at, newDays, existing.id)).items[0]!;
  const price = await currentPrice(tx, deps, dramaId, at, true);
  if ((await tx.cartItem.count({ where: { storeId } })) >= CART_LIMIT)
    throw new AppError("CART_LIMIT_REACHED", { details: { limit: CART_LIMIT } });
  const made = await tx.cartItem.create({
    data: {
      id: uuidv7(),
      entityId,
      storeId,
      dramaId,
      addedByUserId: actor.ctx.actor.id!,
      listPricePoints: price,
      priceAckedAt: null,
      createdAt: at,
      updatedAt: at,
    },
  });
  return (await cartItems(tx, deps, actor, at, newDays, made.id)).items[0]!;
}
export async function removeCart(tx: Tx, actor: OrderActor, id: string) {
  await lockCart(tx, actor.membership.storeId);
  const removed = await tx.cartItem.deleteMany({
    where: { id, storeId: actor.membership.storeId, entityId: actor.membership.entityId },
  });
  if (!removed.count) throw new AppError("NOT_FOUND");
  return null;
}
export async function acceptCartPrice(
  tx: Tx,
  deps: OrderDeps,
  actor: OrderActor,
  id: string,
  accepted: number,
  at: Date,
  newDays: number | null,
) {
  await lockCart(tx, actor.membership.storeId);
  const row = await tx.cartItem.findFirst({
    where: { id, storeId: actor.membership.storeId, entityId: actor.membership.entityId },
  });
  if (!row) throw new AppError("NOT_FOUND");
  const price = await currentPrice(tx, deps, row.dramaId, at, false);
  if (price !== accepted)
    throw new AppError("CART_PRICE_CHANGED", { details: { currentPricePoints: price } });
  if (row.listPricePoints !== price)
    await tx.cartItem.update({
      where: { id },
      data: { listPricePoints: price, priceAckedAt: at, updatedAt: at },
    });
  return { ...(await cartItems(tx, deps, actor, at, newDays, id)).items[0]!, replayed: false };
}
export async function signCart(deps: OrderDeps, item: CartItem) {
  const row = await deps.tx.run((tx) =>
    tx.drama.findUnique({ where: { id: item.drama.dramaId }, select: { posterFileId: true } }),
  );
  if (row?.posterFileId)
    item.drama.posterUrl = await deps.media.signRead({ fileId: row.posterFileId });
  return item;
}
