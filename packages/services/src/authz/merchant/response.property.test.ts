import { z } from "@liyoxi/contract";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AppError } from "../../kernel/index.js";
import { cropMerchantView } from "./response.js";

const clerk = z.object({
  viewerRole: z.literal("clerk"),
  store: z.object({ name: z.string() }),
  items: z.array(z.object({ id: z.string() })),
});
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 200),
  seed: Number(process.env.LYX_FC_SEED ?? 42),
};
describe("按观察者裁剪：性质", () => {
  it("根对象、嵌套对象、数组元素中的随机多余字段都剥掉；不信结果里的 owner", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc
            .string()
            .filter(
              (key) => !["viewerRole", "store", "items", "name", "id", "__proto__"].includes(key),
            ),
          fc.jsonValue(),
        ),
        (extra) => {
          const result = cropMerchantView(
            "clerk",
            { clerk },
            {
              ...extra,
              viewerRole: "owner",
              store: { ...extra, name: "春熙店" },
              items: [{ ...extra, id: "one" }],
            },
          );
          expect(result).toEqual({
            viewerRole: "clerk",
            store: { name: "春熙店" },
            items: [{ id: "one" }],
          });
        },
      ),
      runs,
    );
  });
  it("该角色没有结构即 ROLE_FORBIDDEN（包括匿名）", () => {
    for (const role of ["owner", "guest"] as const) {
      expect(() => cropMerchantView(role, { clerk }, {})).toThrow(
        expect.objectContaining({ error: "ROLE_FORBIDDEN" }),
      );
      try {
        cropMerchantView(role, { clerk }, {});
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
      }
    }
  });
});
