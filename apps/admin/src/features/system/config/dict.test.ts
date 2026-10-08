import { describe, expect, it } from "vitest";
import { ConfigFailure, configResult, errorMessage } from "./api";
import {
  dictBody,
  dictCanDisable,
  dictDepth,
  dictDraft,
  dictSearch,
  type DictItem,
  type DictType,
} from "./model";

const type: DictType = {
  typeKey: "genre",
  name: "题材",
  structure: "flat",
  maxDepth: 1,
  isSystem: false,
  canCreate: true,
  disablePolicy: "block_if_referenced",
  isMerchantVisible: true,
  versionNo: 2,
  itemCount: 1,
  enabledCount: 1,
  levelCounts: [1],
};
const item: DictItem = {
  dictItemId: "01990000-0000-7000-8000-000000000001",
  typeKey: "genre",
  code: "G01",
  parentCode: null,
  name: "都市",
  description: null,
  isEnabled: true,
  tags: [],
  ext: {},
  position: 0,
  refCount: null,
  updatedAt: "2026-10-08T00:00:00Z",
  lockVersion: 3,
};
describe("W207 字典规则与真实错误映射", () => {
  it("实际已消耗的openapi响应仍保留DICT_ITEM_IN_USE和引用计数", async () => {
    const parsed = {
      error: "DICT_ITEM_IN_USE",
      code: 1000,
      message: "仍有引用",
      requestId: "fixture",
      retryable: false,
      details: { refCount: 1 },
    };
    const response = new Response(JSON.stringify(parsed), { status: 409 });
    await response.json();
    expect(response.bodyUsed).toBe(true);
    try {
      await configResult({ error: parsed, response });
      throw new Error("不应成功");
    } catch (error) {
      expect(errorMessage(error)).toBe("此项仍被引用 1 次，不能停用");
    }
  });
  it("新增不提交自造编码；修改携带原版本，不可改类型/上级", () => {
    const draft = { ...dictDraft(), name: "新题材" };
    expect(dictBody(type, draft).body).toEqual({
      typeKey: "genre",
      parentCode: null,
      name: "新题材",
      description: null,
      tags: [],
      ext: {},
    });
    expect(dictBody(type, { ...draft, parentCode: "anything" }, item).body).toEqual({
      lockVersion: 3,
      name: "新题材",
      description: null,
      tags: [],
      ext: {},
    });
  });
  it("系统枚举编辑只提交名称与说明；禁止新增和启停", () => {
    const locked = { ...type, canCreate: false, isSystem: true, disablePolicy: "never" as const };
    expect(
      dictBody(locked, { ...dictDraft(item), name: "显示名", ext: "invalid" }, item).body,
    ).toEqual({ lockVersion: 3, name: "显示名", description: null });
    expect(dictBody(locked, dictDraft()).errors.name).toBeDefined();
    expect(dictCanDisable(locked, item)).toBe(false);
  });
  it("特殊行业不能开放；ext具体字段错误带路径", () => {
    const industry = { ...type, typeKey: "industry" };
    expect(
      dictBody(industry, {
        ...dictDraft(),
        name: "特殊",
        ext: '{"open":true,"special":true,"requiredCerts":[]}',
      }).errors.ext,
    ).toContain("特殊行业");
    expect(
      dictBody(industry, {
        ...dictDraft(),
        name: "行业",
        ext: '{"open":"yes","special":false,"requiredCerts":[]}',
      }).errors["ext.open"],
    ).toBeDefined();
  });
  it("树形深度与URL白名单恢复", () => {
    const child = { ...item, code: "G0101", parentCode: "G01" };
    expect(dictDepth(child, [item, child])).toBe(2);
    expect(
      dictSearch({ type: "unsafe space", id: "x", disabled: "false", q: "  都市  ", foreign: "x" }),
    ).toEqual({ type: undefined, id: undefined, disabled: undefined, q: "都市" });
  });
  it("未知引用来源保持null而非0；409显示实际refCount", () => {
    expect(item.refCount).toBeNull();
    const error = new ConfigFailure({
      symbol: "DICT_ITEM_IN_USE",
      status: 409,
      message: "仍有引用",
      requestId: null,
      disposition: "toast",
      body: {
        error: "DICT_ITEM_IN_USE",
        code: 1000,
        message: "仍有引用",
        requestId: "fixture",
        retryable: false,
        details: { refCount: 7 },
      },
    });
    expect(errorMessage(error)).toContain("7 次");
  });
});
