// 通用结构的用例：标识与标量、分页与排序、信封与错误体（约定 C21、C22、C29–C35、C42–C44）。
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "../zod.js";

import type { ErrorBody } from "../errors/index.js";
import {
  BigIntStringSchema,
  CursorQuerySchema,
  DateSchema,
  DictRefSchema,
  ErrorBodySchema,
  FenSchema,
  IdSchema,
  InstantInputSchema,
  InstantSchema,
  MonthSchema,
  PageQuerySchema,
  SENTRY_ENVELOPE_MAX_BYTES,
  SentryEnvelopeSchema,
  cursorPage,
  envelope,
  errorResponses,
  okResponse,
  openEnum,
  orNull,
  sortQuery,
  type CursorPage,
  type DictRef,
  type OpenEnum,
} from "./index.js";

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe("标识（约定 C29）", () => {
  it("只接受小写、带连字符的 UUID v7", () => {
    expect(ok(IdSchema, "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b")).toBe(true);
    for (const bad of [
      "0192A3B4-C5D6-7E8F-9A0B-1C2D3E4F5A6B", // 大写
      "0192a3b4c5d67e8f9a0b1c2d3e4f5a6b", // 没有连字符
      "0192a3b4-c5d6-4e8f-9a0b-1c2d3e4f5a6b", // 版本位是 4
      "0192a3b4-c5d6-7e8f-ca0b-1c2d3e4f5a6b", // 变体位不对
      "1024", // 旧稿的 bigint 写法
      "",
      1024,
      null,
    ]) {
      expect(ok(IdSchema, bad), String(bad)).toBe(false);
    }
  });
});

describe("金额、积分、比例、大整数（约定 C31–C33）", () => {
  it("金额是整数分：小数、字符串、超出安全整数的都拒绝", () => {
    for (const good of [0, 1, -500, 9_007_199_254_740_991]) expect(ok(FenSchema, good)).toBe(true);
    for (const bad of [0.5, "100", Number.NaN, 2 ** 53]) expect(ok(FenSchema, bad)).toBe(false);
  });
  it("bigint 出接口为十进制字符串", () => {
    for (const good of ["0", "5368709120", "-12"]) expect(ok(BigIntStringSchema, good)).toBe(true);
    for (const bad of ["", "1.5", "1e3", "+1", " 1", 1]) {
      expect(ok(BigIntStringSchema, bad)).toBe(false);
    }
  });
});

describe("时刻、日期、月份（约定 C34、C35）", () => {
  it("输出的时刻是 UTC、毫秒三位、以 Z 结尾", () => {
    expect(ok(InstantSchema, new Date(0).toISOString())).toBe(true);
    expect(ok(InstantSchema, "2026-10-02T04:13:20.000Z")).toBe(true);
    for (const bad of [
      "2026-10-02T04:13:20Z", // 没有毫秒
      "2026-10-02T04:13:20.000+08:00", // 不是 UTC
      "2026-10-02T04:13:20.000", // 没有偏移
      "2026-10-02",
    ]) {
      expect(ok(InstantSchema, bad), bad).toBe(false);
    }
  });
  it("输入的时刻接受任意偏移；不带偏移即拒绝", () => {
    for (const good of [
      "2026-10-02T04:13:20Z",
      "2026-10-02T12:13:20+08:00",
      "2026-10-02T04:13:20.123Z",
    ]) {
      expect(ok(InstantInputSchema, good), good).toBe(true);
    }
    for (const bad of ["2026-10-02T04:13:20", "2026-10-02 04:13:20", "2026-10-02"]) {
      expect(ok(InstantInputSchema, bad), bad).toBe(false);
    }
  });
  it("日期 YYYY-MM-DD，月份 YYYY-MM", () => {
    expect(ok(DateSchema, "2026-10-02")).toBe(true);
    for (const bad of ["2026-13-01", "2026-02-30", "2026/10/02", "20261002"]) {
      expect(ok(DateSchema, bad), bad).toBe(false);
    }
    expect(ok(MonthSchema, "2026-09")).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-9", "2026-09-01"]) {
      expect(ok(MonthSchema, bad), bad).toBe(false);
    }
  });
});

describe("分页与排序（约定 C42–C44）", () => {
  it("游标分页：limit 默认 20、上限 50；cursor 首页不传", () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorQuerySchema.parse({ cursor: "abc", limit: "50" })).toEqual({
      cursor: "abc",
      limit: 50,
    });
    for (const bad of [{ limit: "51" }, { limit: "0" }, { limit: "x" }, { cursor: "" }]) {
      expect(ok(CursorQuerySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("游标分页的响应是 { items, nextCursor, hasMore }，末页 nextCursor 为 null", () => {
    const page = cursorPage(DictRefSchema);
    expect(ok(page, { items: [], nextCursor: null, hasMore: false })).toBe(true);
    expect(ok(page, { items: [], hasMore: false })).toBe(false);
    expectTypeOf<z.infer<typeof page>>().toEqualTypeOf<CursorPage<DictRef>>();
  });
  it("页码分页：page 从 1 开始，pageSize 默认 20、上限 100", () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(PageQuerySchema.parse({ page: "3", pageSize: "100" })).toEqual({
      page: 3,
      pageSize: 100,
    });
    for (const bad of [{ page: "0" }, { pageSize: "101" }, { pageSize: "1.5" }]) {
      expect(ok(PageQuerySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("排序：逗号分隔，- 表示降序，只收声明过的键", () => {
    const sort = sortQuery(["createdAt", "orderNo", "urgency"], "-createdAt");
    expect(sort.parse(undefined)).toBe("-createdAt");
    expect(sort.parse("-createdAt,orderNo")).toBe("-createdAt,orderNo");
    expect(sort.parse("urgency")).toBe("urgency");
    for (const bad of ["id", "createdAt,", "+createdAt", "createdAt;orderNo", ""]) {
      expect(ok(sort, bad), bad).toBe(false);
    }
    expect(() => sortQuery(["createdAt"], "-orderNo")).toThrow(/默认排序/);
    expect(() => sortQuery(["created-at"], "created-at")).toThrow(/驼峰/);
  });
});

describe("信封与错误体（约定 C21、C22、C24）", () => {
  it("成功体 { code: 0, message: 'ok', data }；没有内容时 data 为 null", () => {
    const schema = envelope(DictRefSchema);
    expect(ok(schema, { code: 0, message: "ok", data: { code: "a", name: "甲" } })).toBe(true);
    expect(ok(schema, { code: 1, message: "ok", data: { code: "a", name: "甲" } })).toBe(false);
    expect(ok(schema, { code: 0, message: "ok" })).toBe(false);
    expect(ok(envelope(orNull(DictRefSchema)), { code: 0, message: "ok", data: null })).toBe(true);
  });
  it("错误体与纯类型一侧同形；未声明的键被剥离", () => {
    expectTypeOf<z.infer<typeof ErrorBodySchema>>().toEqualTypeOf<ErrorBody>();
    const body = {
      code: 40901,
      error: "VERSION_CONFLICT",
      message: "内容已被他人修改，请刷新后重试",
      retryable: false,
      requestId: "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b",
    };
    expect(ErrorBodySchema.parse({ ...body, stack: "不该出去" })).toEqual(body);
    expect(ok(ErrorBodySchema, { ...body, retryable: undefined })).toBe(false);
  });
  it("响应声明只给约定里的状态：200 带信封，错误状态都指向 ErrorBody", () => {
    const responses = { ...okResponse(DictRefSchema), ...errorResponses(400, 404) };
    expect(Object.keys(responses)).toEqual(["200", "400", "404"]);
    expect(responses[404].content["application/json"].schema).toBe(ErrorBodySchema);
    // @ts-expect-error 422 不在约定 C24 的状态之内
    errorResponses(422);
  });
});

describe("通用结构与开放枚举（约定 C37、C87）", () => {
  it("SentryEnvelope 是 ≤200KB 的原文", () => {
    expect(ok(SentryEnvelopeSchema, "{}\n{}")).toBe(true);
    expect(ok(SentryEnvelopeSchema, "")).toBe(false);
    expect(ok(SentryEnvelopeSchema, "x".repeat(SENTRY_ENVELOPE_MAX_BYTES + 1))).toBe(false);
  });
  it("开放枚举：Zod 一侧是闭集，开口只开在给端上的类型里", () => {
    const status = openEnum(["draft", "live"]);
    expect(ok(status, "live")).toBe(true);
    expect(ok(status, "archived")).toBe(false);
    expectTypeOf<z.infer<typeof status>>().toEqualTypeOf<"draft" | "live">();
    const future: OpenEnum<"draft" | "live"> = "archived";
    expect(future).toBe("archived");
  });
});
