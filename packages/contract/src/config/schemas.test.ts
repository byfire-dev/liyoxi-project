// config 各 jsonb 列结构的自测（任务书 W0-18 第 7 节第 7 条）：14 分组 第 4 节的例子通过，写明的限制各有一个反例。
import { describe, expect, it } from "vitest";

import { SITE_CONFIG_REVISION_CONFIG_KEY } from "../enums/index.js";

import {
  DICT_EXT_SCHEMAS,
  DICT_SELECTABLE_EXT_FLAG,
  dictExtSchema,
  MERCHANT_DICT_EXT_KEYS,
} from "./dict-ext.js";
import {
  ChecklistItemsSchema,
  FlagRulesSchema,
  HomeRecommendConfigSchema,
  isFlagValueOfType,
  MallConfigSchema,
  SITE_CONFIG_SCHEMAS,
  VERSION_RANGE_PATTERN,
} from "./schemas.js";
import type { MallConfig } from "./schemas.js";

const ENTITY = "019a0000-0000-7000-8000-000000000001";
const DRAMA = "019a0000-0000-7000-8000-000000000002";
const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("开关规则（14 分组 第 4.6 节）", () => {
  it("四种条件都能写；空数组是合法的规则表", () => {
    expect(ok(FlagRulesSchema, [])).toBe(true);
    expect(
      ok(FlagRulesSchema, [
        { when: { platform: ["ios", "android"] }, value: true },
        { when: { clientVersion: ">=1.2.0 <2.0.0" }, value: "b" },
        { when: { envVersion: ["develop", "trial"] }, value: { title: "维护" } },
        { when: { entityIds: [ENTITY], platform: ["devtools"] }, value: null },
      ]),
    ).toBe(true);
  });

  it.each([
    ["没有条件", { when: {}, value: true }],
    ["条件之外的键（不做百分比灰度、不设审核态）", { when: { percent: 10 }, value: true }],
    ["版本范围写法不对", { when: { clientVersion: "^1.2.0" }, value: true }],
    ["版本范围带预发布标记", { when: { clientVersion: ">=1.2.0-beta" }, value: true }],
    ["环境之外的取值", { when: { envVersion: ["review"] }, value: true }],
    ["主体不是 uuid", { when: { entityIds: ["E001"] }, value: true }],
    ["条件给了空数组", { when: { platform: [] }, value: true }],
    ["没有 value", { when: { platform: ["ios"] } }],
    ["规则多了键", { when: { platform: ["ios"] }, value: true, note: "x" }],
  ])("拒绝：%s", (_, rule) => {
    expect(ok(FlagRulesSchema, [rule])).toBe(false);
  });

  it("版本范围：只认用空格连起来的比较式", () => {
    for (const range of ["=1.0.0", ">=0.0.0", ">1.2.3 <=10.20.30", "<2.0.0"]) {
      expect(VERSION_RANGE_PATTERN.test(range), range).toBe(true);
    }
    for (const range of ["1.0.0", ">=1.0", ">= 1.0.0", ">=1.0.0||<2.0.0", "~1.0.0", ""]) {
      expect(VERSION_RANGE_PATTERN.test(range), range).toBe(false);
    }
  });

  it("值类型：bool 是布尔，enum 是字符串，json 不限", () => {
    expect(isFlagValueOfType("bool", true)).toBe(true);
    expect(isFlagValueOfType("bool", "true")).toBe(false);
    expect(isFlagValueOfType("enum", "a")).toBe(true);
    expect(isFlagValueOfType("enum", 1)).toBe(false);
    expect(isFlagValueOfType("json", null)).toBe(true);
    expect(isFlagValueOfType("json", "0.0.0")).toBe(true);
    expect(isFlagValueOfType("json", undefined)).toBe(false);
  });
});

describe("清单条目（14 分组 第 4.7 节）", () => {
  const item = { key: "subtitle", label: "字幕无错别字", required: true, allowNa: false };

  it("例子通过；hint 可省；草稿可以为空", () => {
    expect(
      ok(ChecklistItemsSchema, [
        { ...item, merchantVisible: true, hint: "逐句核对" },
        { ...item, key: "aiMark", label: "AI 标识", merchantVisible: false },
      ]),
    ).toBe(true);
    expect(ok(ChecklistItemsSchema, [])).toBe(true);
  });

  it.each([
    [
      "键重复",
      [
        { ...item, merchantVisible: true },
        { ...item, merchantVisible: false },
      ],
    ],
    ["少了必填的布尔", [item]],
    ["label 为空", [{ ...item, label: " ", merchantVisible: true }]],
    ["多了键", [{ ...item, merchantVisible: true, weight: 1 }]],
    ["键的写法不对", [{ ...item, key: "1st", merchantVisible: true }]],
  ])("拒绝：%s", (_, items) => {
    expect(ok(ChecklistItemsSchema, items)).toBe(false);
  });
});

describe("站点配置（14 分组 第 4.3 节）", () => {
  const mall: MallConfig = {
    categories: [
      { key: "all", name: "全部", genreCodes: [], visible: true, fixed: true },
      { key: "food", name: "美食", genreCodes: ["G01", "G02"], visible: true, fixed: false },
    ],
    hotWords: ["火锅", "探店"],
    filters: {
      genre: true,
      industry: true,
      episodes: true,
      price: false,
      episodeBands: [
        { key: "short", label: "30 集以内", min: null, max: 30 },
        { key: "long", label: "60 集以上", min: 60, max: null },
      ],
      priceBands: [],
    },
    sorts: ["composite", "heat", "price_asc", "newest"],
    defaultSort: "composite",
    weights: { heat: 40, sales30d: 30, freshness: 20, manual: 10 },
  };
  const change = (patch: (draft: MallConfig) => void): MallConfig => {
    const draft = structuredClone(mall);
    patch(draft);
    return draft;
  };

  it("配置键与库的枚举相同；一份合规的商城配置通过", () => {
    expect(Object.keys(SITE_CONFIG_SCHEMAS).sort()).toEqual(
      [...SITE_CONFIG_REVISION_CONFIG_KEY.values].sort(),
    );
    expect(MallConfigSchema.safeParse(mall).error?.issues).toBeUndefined();
  });

  it.each<[string, MallConfig]>([
    ["没有固定分类", change((d) => void (d.categories[0]!.fixed = false))],
    ["固定分类不在第一", change((d) => void d.categories.reverse())],
    ["固定分类的 key 不是 all", change((d) => void (d.categories[0]!.key = "whole"))],
    ["固定分类被隐藏", change((d) => void (d.categories[0]!.visible = false))],
    ["固定分类带了题材", change((d) => void (d.categories[0]!.genreCodes = ["G01"]))],
    ["其余分类没有题材", change((d) => void (d.categories[1]!.genreCodes = []))],
    ["其余分类题材重复", change((d) => void (d.categories[1]!.genreCodes = ["G01", "G01"]))],
    ["分类名超过 4 个字", change((d) => void (d.categories[1]!.name = "美食与饮品"))],
    ["分类重名", change((d) => void (d.categories[1]!.name = "全部"))],
    ["分类 key 重复", change((d) => void d.categories.push({ ...d.categories[1]!, name: "小吃" }))],
    [
      "分类超过 10 个",
      change((d) => {
        for (let n = 0; n < 9; n += 1) {
          d.categories.push({ ...d.categories[1]!, key: `c${String(n)}`, name: `类${String(n)}` });
        }
      }),
    ],
    ["热词超过 8 个字", change((d) => void (d.hotWords = ["这是一个很长的搜索词"]))],
    ["热词超过 8 个", change((d) => void (d.hotWords = [..."一二三四五六七八九"]))],
    ["开了集数筛选却没有分档", change((d) => void (d.filters.episodeBands = []))],
    ["开了积分价筛选却没有分档", change((d) => void (d.filters.price = true))],
    [
      "分档两头都空",
      change(
        (d) =>
          void (d.filters.episodeBands[0] = { key: "any", label: "不限", min: null, max: null }),
      ),
    ],
    ["分档 min 大于 max", change((d) => void (d.filters.episodeBands[0]!.min = 31))],
    ["分档为负", change((d) => void (d.filters.episodeBands[1]!.min = -1))],
    ["分档重名", change((d) => void (d.filters.episodeBands[1]!.label = "30 集以内"))],
    ["排序项为空", change((d) => void (d.sorts = []))],
    ["排序项重复", change((d) => void (d.sorts = ["heat", "heat"]))],
    ["权重合计不是 100", change((d) => void (d.weights.manual = 11))],
    ["多了键", change((d) => void Object.assign(d, { banner: [] }))],
  ])("商城配置拒绝：%s", (_, config) => {
    expect(ok(MallConfigSchema, config)).toBe(false);
  });

  it("首页推荐位：范围与“每个行业至多 1 部”", () => {
    const home = {
      recommendCount: 6,
      pins: [{ industryCode: "C01", dramaId: DRAMA }],
      defaultTab: "hot",
      newDays: 30,
    };
    expect(ok(HomeRecommendConfigSchema, home)).toBe(true);
    expect(ok(HomeRecommendConfigSchema, { ...home, pins: [] })).toBe(true);
    for (const bad of [
      { ...home, recommendCount: 2 },
      { ...home, recommendCount: 13 },
      { ...home, newDays: 6 },
      { ...home, newDays: 91 },
      { ...home, defaultTab: "top" },
      { ...home, pins: [home.pins[0], home.pins[0]] },
      { ...home, pins: [{ industryCode: "C01", dramaId: "D1" }] },
    ]) {
      expect(ok(HomeRecommendConfigSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("字典项扩展属性（14 分组 第 4.1 节）", () => {
  // 14 分组 第 2.1 节播种的 food_business
  const foodBusiness = {
    fields: [
      { key: "operatorName", label: "经营者名称", sensitive: false, format: "text" },
      { key: "certNo", label: "许可证编号", sensitive: true, format: "cert_no" },
      { key: "premises", label: "经营场所", sensitive: false, format: "text" },
      { key: "businessItems", label: "经营项目", sensitive: false, format: "text" },
      { key: "validTo", label: "有效期至", sensitive: false, format: "date" },
    ],
    holderNameKey: "operatorName",
    certNoKey: "certNo",
    certNoPattern: "^JY[0-9]{14}$",
    principalNameKey: null,
    validFromKey: null,
    validToKey: "validTo",
  };

  it("各类型的例子通过", () => {
    const examples: Record<keyof typeof DICT_EXT_SCHEMAS, unknown> = {
      industry: { open: true, special: false, requiredCerts: ["food_business"] },
      region: { level: 2, functionalZone: false, opened: true },
      reject_reason: { scene: "cancel_refund" },
      ticket_type: {
        defaultPriority: "mid",
        transferable: true,
        notifyLead: false,
        isAfterSales: false,
      },
      asset_tag: { dimension: "content" },
      permit_type: foodBusiness,
      store_selling_point: { categoryCodes: [] },
    };
    for (const [typeKey, example] of Object.entries(examples)) {
      expect(dictExtSchema(typeKey).safeParse(example).error?.issues, typeKey).toBeUndefined();
    }
  });

  it("没登记的类型是空对象", () => {
    expect(ok(dictExtSchema("genre"), {})).toBe(true);
    expect(ok(dictExtSchema("genre"), { hot: true })).toBe(false);
    // 原型链上的名字不当成登记过的类型
    expect(ok(dictExtSchema("constructor"), {})).toBe(true);
  });

  it.each([
    ["特殊行业不可开放", "industry", { open: true, special: true, requiredCerts: [] }],
    ["区划层级只有 1–3", "region", { level: 4, functionalZone: false, opened: true }],
    ["驳回场景之外的取值", "reject_reason", { scene: "other" }],
    [
      "工单类型四个键都必填",
      "ticket_type",
      { defaultPriority: "mid", transferable: true, notifyLead: false },
    ],
    ["素材标签的维度之外", "asset_tag", { dimension: "mood" }],
    ["许可证的 *Key 不在 fields 里", "permit_type", { ...foodBusiness, validToKey: "expireAt" }],
    ["许可证的编号正则不合法", "permit_type", { ...foodBusiness, certNoPattern: "^(JY" }],
    [
      "许可证的字段键重复",
      "permit_type",
      { ...foodBusiness, fields: [foodBusiness.fields[0], foodBusiness.fields[0]] },
    ],
    ["卖点的品类编码写法不对", "store_selling_point", { categoryCodes: ["C 01"] }],
  ])("拒绝：%s", (_, typeKey, ext) => {
    expect(ok(dictExtSchema(typeKey), ext)).toBe(false);
  });

  it("小程序白名单与可选标记里的键，都是对应结构里有的键", () => {
    const shapeKeys = (typeKey: string): string[] =>
      Object.keys(
        (
          DICT_EXT_SCHEMAS[typeKey as keyof typeof DICT_EXT_SCHEMAS] as unknown as {
            shape: Record<string, unknown>;
          }
        ).shape,
      );
    for (const [typeKey, keys] of Object.entries(MERCHANT_DICT_EXT_KEYS)) {
      for (const key of keys) expect(shapeKeys(typeKey), `${typeKey}.${key}`).toContain(key);
    }
    for (const [typeKey, key] of Object.entries(DICT_SELECTABLE_EXT_FLAG)) {
      expect(shapeKeys(typeKey), typeKey).toContain(key);
      // 用在过滤上的键不下发
      expect(MERCHANT_DICT_EXT_KEYS[typeKey], typeKey).not.toContain(key);
    }
    // 工单类型只下发 isAfterSales（A145）
    expect(MERCHANT_DICT_EXT_KEYS.ticket_type).toEqual(["isAfterSales"]);
  });
});
