import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "../../events/index.js";
import {
  DramaBasicBodySchema,
  DramaListQuerySchema,
  DramaPermitCreateBodySchema,
  DramaEpisodeUpdateBodySchema,
  DramaPermitListQuerySchema,
} from "./drama-lifecycle.schemas.js";
const id = "019a1111-1111-7111-8111-111111111111";
describe("W309正式生命周期输入", () => {
  it("只接正式字段、分页筛选和许可多状态，不允许剧集标题PATCH替换原片", () => {
    expect(DramaListQuerySchema.parse({ isArchived: "false", pageSize: "100" })).toMatchObject({
      isArchived: false,
      page: 1,
      pageSize: 100,
    });
    expect(DramaListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(DramaPermitListQuerySchema.parse({ status: "active,retired" }).status).toBe(
      "active,retired",
    );
    expect(DramaBasicBodySchema.safeParse({ lockVersion: 0, totalEpisodes: 0 }).success).toBe(
      false,
    );
    expect(
      DramaEpisodeUpdateBodySchema.safeParse({ dramaLockVersion: 0, title: "标题", fileId: id })
        .success,
    ).toBe(false);
  });
  it("换号必须成对提供真实旧许可及退役理由", () => {
    const base = { platform: "all", permitKind: "program_no", permitNo: "X", scanFileIds: [id] };
    expect(
      DramaPermitCreateBodySchema.safeParse({ ...base, replacesDramaPermitId: id }).success,
    ).toBe(false);
    expect(
      DramaPermitCreateBodySchema.safeParse({
        ...base,
        replacesDramaPermitId: id,
        retireReason: "换号",
      }).success,
    ).toBe(true);
  });
  it("原首次上架严格支原样，重新上架仅接受delisted/relist/true组合", () => {
    const schema = EVENT_PAYLOAD_SCHEMAS["drama.listed"],
      base = { v: 1, dramaId: id, toState: "listed" };
    expect(
      schema.safeParse({ ...base, fromState: "draft", transition: "drama.list", isRelist: false })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        fromState: "delisted",
        transition: "drama.relist",
        isRelist: true,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...base, fromState: "draft", transition: "drama.relist", isRelist: true })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        fromState: "delisted",
        transition: "drama.list",
        isRelist: false,
      }).success,
    ).toBe(false);
  });
});
