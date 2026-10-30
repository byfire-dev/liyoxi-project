import { OrderQuoteResultSchema } from "@liyoxi/contract";
import type { AdminOrderQuoteBody } from "@liyoxi/contract";
import { quoteDramaItem } from "@liyoxi/shared/pricing";
import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt, priceAt } from "../billing/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderDeps } from "./context.js";

/** Current plan revisions supply R/T; this read never requires or advances a merchant term. */
export async function adminQuote(tx: Tx, deps: OrderDeps, input: AdminOrderQuoteBody, at: Date) {
  const drama = await tx.drama.findUnique({ where: { id: input.dramaId } });
  if (!drama) throw new AppError("NOT_FOUND");
  const plan = await tx.plan.findUnique({
    where: { code: input.planCode },
    include: {
      planRevisions: {
        where: { effectiveAt: { lte: at }, cancelledAt: null },
        orderBy: { effectiveAt: "desc" },
        take: 1,
      },
    },
  });
  const revision = plan?.planRevisions[0];
  if (!plan || !revision) throw new AppError("PLAN_NOT_AVAILABLE");
  const params = await paramsAt(tx, at),
    price = (await priceAt(tx, [drama.id], at)).get(drama.id),
    current = await tx.dramaPriceRevision.findFirst({
      where: { dramaId: drama.id, effectiveAt: { lte: at }, cancelledAt: null },
      orderBy: { effectiveAt: "desc" },
    }),
    fact = (await deps.content.getOrderability(tx, [drama.id], calendarDate(at))).get(drama.id),
    isTopModelSelected = revision.productionModel === "top" || input.isTopModel,
    q =
      typeof price === "object"
        ? quoteDramaItem({
            listPricePoints: price.points,
            discountBp: revision.discountBp,
            topModelSurchargeBp: params.topModelSurchargeBp,
            isTopModelSelected,
            isTopModelIncluded: revision.productionModel === "top",
          })
        : null,
    surchargeBp =
      revision.productionModel !== "top" && input.isTopModel ? params.topModelSurchargeBp : 0;
  const discounted =
    typeof price === "object"
      ? quoteDramaItem({
          listPricePoints: price.points,
          discountBp: revision.discountBp,
          topModelSurchargeBp: 0,
          isTopModelSelected: false,
          isTopModelIncluded: false,
        }).chargePoints
      : null;
  return OrderQuoteResultSchema.parse({
    quotedAt: at.toISOString(),
    dramaId: drama.id,
    dramaTitle: drama.title,
    heatTier: drama.heatTier,
    priceMode: current?.mode ?? "template",
    listPricePoints: typeof price === "object" ? price.points : null,
    planCode: plan.code,
    planName: plan.name,
    discountBp: revision.discountBp,
    productionModel: revision.productionModel,
    isTopModelSelected,
    surchargeBp,
    discountedPoints: discounted,
    chargePoints: q?.chargePoints ?? null,
    formula:
      q && typeof price === "object"
        ? `${price.points} × ${revision.discountBp / 10000} × (1 + ${surchargeBp / 100}%) = ${q.chargePoints}`
        : null,
    orderable: fact?.orderable ?? false,
    unorderableReason: fact ? fact.reason : "not_listed",
  });
}
