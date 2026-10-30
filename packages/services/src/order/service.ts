import {
  OrderQuoteBodySchema,
  OrderCreateBodySchema,
  AdminOrderQuoteBodySchema,
} from "@liyoxi/contract";
import type { OrderQuoteBody, OrderCreateBody } from "@liyoxi/contract";
import type { IdempotencyContext } from "../kernel/index.js";
import { owner } from "./checks.js";
import type { OrderActor, OrderDeps } from "./context.js";
import { quote } from "./quote.js";
import { submit } from "./submit.js";
import { signDetail } from "./read.js";
import { detail } from "./read.js";
import {
  MerchantOrderListQuerySchema,
  MerchantOrderItemQuerySchema,
  CartAcceptBodySchema,
} from "@liyoxi/contract";
import type {
  MerchantOrderListQuery,
  MerchantOrderItemQuery,
  AdminOrderFilters,
  AdminOrderListQuery,
} from "@liyoxi/contract";
import type { DataScope } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import { cartItems, addCart, removeCart, acceptCartPrice, signCart } from "./cart.js";
import { listOrders, listItems, itemDetail, itemSummary, signItems } from "./merchant-read.js";
import { adminList, adminSummary, adminDetail } from "./admin-read.js";
import { adminQuote } from "./admin-quote.js";
import { orderActivity } from "./activity-read.js";
import { signOrderReferenceFiles } from "./reference-files.js";
export function createOrderService(deps: OrderDeps) {
  const newDays = async () =>
    (await deps.config.siteConfig.published("home_recommend"))?.content.newDays ?? null;
  return {
    async adminQuote(input: unknown) {
      const parsed = AdminOrderQuoteBodySchema.parse(input),
        at = deps.clock.now();
      return deps.tx.run((tx) => adminQuote(tx, deps, parsed, at));
    },
    async activityList(scope: DataScope, id: string, input: unknown) {
      return deps.tx.run((tx) => orderActivity(tx, scope, id, input));
    },
    async adminList(scope: DataScope, input: AdminOrderListQuery) {
      const at = deps.clock.now();
      return deps.tx.run((tx) => adminList(tx, scope, input, at));
    },
    async adminSummary(scope: DataScope, input: AdminOrderFilters) {
      const at = deps.clock.now();
      return deps.tx.run((tx) => adminSummary(tx, scope, input, at));
    },
    async adminGet(scope: DataScope, id: string) {
      const at = deps.clock.now();
      const view = await deps.tx.run((tx) => adminDetail(tx, scope, id, at));
      return signOrderReferenceFiles(deps, scope, view);
    },
    async cartList(actor: OrderActor) {
      owner(actor);
      const at = deps.clock.now(),
        days = await newDays();
      const view = await deps.tx.run((tx) => cartItems(tx, deps, actor, at, days));
      for (const item of view.items) await signCart(deps, item);
      return view;
    },
    async cartCreate(actor: OrderActor, dramaId: string) {
      owner(actor);
      if (actor.membership.storeMode === "archived") throw new AppError("STORE_ARCHIVED");
      const at = deps.clock.now(),
        days = await newDays();
      return signCart(deps, await deps.tx.run((tx) => addCart(tx, deps, actor, dramaId, at, days)));
    },
    async cartDelete(actor: OrderActor, id: string, options: { idem?: IdempotencyContext } = {}) {
      owner(actor);
      return deps.tx.run((tx) => removeCart(tx, actor, id), options);
    },
    async cartAcceptPrice(
      actor: OrderActor,
      id: string,
      input: { acceptedPricePoints: number },
      options: { idem?: IdempotencyContext } = {},
    ) {
      owner(actor);
      const parsed = CartAcceptBodySchema.parse(input),
        at = deps.clock.now(),
        days = await newDays();
      const result = await deps.tx.run(
        (tx) => acceptCartPrice(tx, deps, actor, id, parsed.acceptedPricePoints, at, days),
        options,
      );
      if (result.replayed || options.idem?.replayed) return { ...result, replayed: true };
      return { ...(await signCart(deps, result)), replayed: false };
    },
    async list(actor: OrderActor, input: MerchantOrderListQuery) {
      owner(actor);
      return deps.tx.run((tx) => listOrders(tx, actor, MerchantOrderListQuerySchema.parse(input)));
    },
    async get(actor: OrderActor, id: string) {
      owner(actor);
      return signDetail(deps, await deps.tx.run((tx) => detail(tx, actor, id, deps.clock.now())));
    },
    async itemList(actor: OrderActor, input: MerchantOrderItemQuery) {
      owner(actor);
      const at = deps.clock.now(),
        view = await deps.tx.run((tx) =>
          listItems(tx, actor, MerchantOrderItemQuerySchema.parse(input), at),
        );
      await signItems(deps, view.items);
      return view;
    },
    async itemSummary(actor: OrderActor, orderId?: string) {
      owner(actor);
      return deps.tx.run((tx) => itemSummary(tx, actor, orderId));
    },
    async itemGet(actor: OrderActor, id: string) {
      owner(actor);
      const at = deps.clock.now(),
        result = await deps.tx.run((tx) => itemDetail(tx, actor, id, at));
      await signItems(deps, [result]);
      return result;
    },
    async quote(actor: OrderActor, input: OrderQuoteBody) {
      owner(actor);
      const parsed = OrderQuoteBodySchema.parse(input),
        at = deps.clock.now();
      // 配置缓存可能读取 Redis，须在领域只读事务外完成。
      const home = await deps.config.siteConfig.published("home_recommend");
      const view = await deps.tx.run((tx) =>
        quote(tx, deps, actor, parsed, at, home?.content.newDays ?? null),
      );
      const posters = await deps.tx.run((tx) =>
        tx.drama.findMany({
          where: { id: { in: parsed.dramaIds } },
          select: { id: true, posterFileId: true },
        }),
      );
      for (const item of view.items) {
        const file = posters.find((p) => p.id === item.drama.dramaId);
        if (file?.posterFileId)
          item.drama.posterUrl = await deps.media.signRead({ fileId: file.posterFileId });
      }
      return view;
    },
    async create(
      actor: OrderActor,
      input: OrderCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) {
      owner(actor);
      const parsed = OrderCreateBodySchema.parse(input);
      const result = await deps.tx.run((tx) => submit(tx, deps, actor, parsed), options);
      if (result.replayed || options.idem?.replayed) return { ...result, replayed: true };
      return { ...(await signDetail(deps, result)), replayed: false };
    },
  };
}
export type OrderService = ReturnType<typeof createOrderService>;
