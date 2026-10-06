import { OrderQuoteBodySchema, OrderCreateBodySchema } from "@liyoxi/contract";
import type { OrderQuoteBody, OrderCreateBody } from "@liyoxi/contract";
import type { IdempotencyContext } from "../kernel/index.js";
import { owner } from "./checks.js";
import type { OrderActor, OrderDeps } from "./context.js";
import { quote } from "./quote.js";
import { submit } from "./submit.js";
import { signDetail } from "./read.js";
export function createOrderService(deps: OrderDeps) {
  return {
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
