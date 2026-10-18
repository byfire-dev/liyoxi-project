import { expect, it } from "vitest";
import { MallConfigSchema } from "../../config/schemas.js";
import { DramaSearchQuerySchema } from "../m04-mall-order/mall.schemas.js";
const content = {
  categories: [{ key: "all", name: "全部", genreCodes: [], visible: true, fixed: true }],
  hotWords: [],
  filters: {
    genre: false,
    industry: false,
    episodes: false,
    price: false,
    episodeBands: [],
    priceBands: [],
  },
  sorts: ["heat"],
  defaultSort: "heat",
  weights: { heat: 25, sales30d: 25, freshness: 25, manual: 25 },
};
it("正式商城约束拒绝重复热词和不在sorts的defaultSort", () => {
  expect(MallConfigSchema.safeParse(content).success).toBe(true);
  expect(MallConfigSchema.safeParse({ ...content, hotWords: ["店里", "店里"] }).success).toBe(
    false,
  );
  expect(MallConfigSchema.safeParse({ ...content, defaultSort: "composite" }).success).toBe(false);
});
it("关键词先去空格与间隔点，再按字数验证", () => {
  expect(DramaSearchQuerySchema.parse({ q: " 都·市 " }).q).toBe("都市");
  expect(DramaSearchQuerySchema.safeParse({ q: " · " }).success).toBe(false);
  expect(DramaSearchQuerySchema.safeParse({ q: "剧".repeat(21) }).success).toBe(false);
});
