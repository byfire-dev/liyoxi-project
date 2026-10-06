import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "@liyoxi/contract/types/merchant";
import type { DictRef } from "../../common/index.js";
import { AddressViewSchema, MediaFileViewSchema } from "./profile.schemas.js";
import { QualificationDocSchema } from "./qualification.schemas.js";

describe("本域命名结构的可空引用", () => {
  it("生成类型接受有值与空字典，媒体组件的原字段仍必有", () => {
    expectTypeOf<
      components["schemas"]["AddressView"]["province"]
    >().toEqualTypeOf<DictRef | null>();
    expectTypeOf<
      components["schemas"]["QualificationDoc"]["permitType"]
    >().toEqualTypeOf<DictRef | null>();
    expectTypeOf<Pick<components["schemas"]["MediaFileView"], "fileId">>().toEqualTypeOf<{
      fileId: string;
    }>();
    const region: components["schemas"]["AddressView"] = {
      province: { code: "110000", name: "测试省" },
      city: null,
      district: null,
      zone: null,
      detail: null,
      poiName: null,
      latitude: null,
      longitude: null,
    };
    expect(AddressViewSchema.parse(region)).toEqual(region);
    expect(MediaFileViewSchema.safeParse({}).success).toBe(false);
    expect(
      QualificationDocSchema.shape.permitType.parse({ code: "P01", name: "食品许可证" }),
    ).toEqual({ code: "P01", name: "食品许可证" });
    expect(QualificationDocSchema.shape.permitType.parse(null)).toBeNull();
  });
});
