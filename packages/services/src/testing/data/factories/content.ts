// 内容：drama、drama_episode（05 分组）。
import { defined } from "./context.js";
import type { FactoryContext } from "./context.js";
import type { Factories, TableFactories } from "./types.js";

export function contentFactories(
  ctx: FactoryContext,
  make: Factories,
): Pick<TableFactories, "drama" | "dramaEpisode"> {
  return {
    /**
     * 缺省：已上架、共 3 集。status 写 draft 就是没上过架的草稿；写 delisted 会补上下架时间与原因。
     * 建剧人没给时造一位内容运营。只是 drama 这一行：许可、版权、积分价、剧集不带。
     */
    async drama(input = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      const status = input.status ?? "listed";
      const staffId =
        input.createdByStaffId ??
        input.updatedByStaffId ??
        (await make.staff({ staffRoleKey: "content_ops" })).id;
      return ctx.db.drama.create({
        data: {
          id: ctx.id(),
          title: `测试短剧${n}`,
          statusChangedAt: now,
          ...(status === "draft" ? {} : { firstListedAt: now, listedAt: now }),
          ...(status === "delisted" ? { delistedAt: now, delistReasonCode: "ops_strategy" } : {}),
          totalEpisodes: 3,
          createdByStaffId: staffId,
          updatedByStaffId: staffId,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          status,
        },
      });
    },

    /** 缺省：这部剧的下一集（集号 = 已有的集数 + 1），一分钟 */
    async dramaEpisode(input = {}) {
      const now = ctx.now();
      const dramaId = input.dramaId ?? (await make.drama()).id;
      return ctx.db.dramaEpisode.create({
        data: {
          id: ctx.id(),
          episodeNo: (await ctx.db.dramaEpisode.count({ where: { dramaId } })) + 1,
          durationMs: 60_000,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          dramaId,
        },
      });
    },
  };
}
