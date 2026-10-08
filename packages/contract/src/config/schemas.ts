// config 模块三处 jsonb 列的结构（W0-18）：开关规则、清单条目、站点配置。依据：14 分组 第 4.3、4.6、4.7 节。
// 写入方（后台接口、种子）落库前用它校验，读取方（services 的 config）读出来再过一遍。
// 带 Zod：只从包入口给出，不进 ./config/flags、./config/params 两个纯常量子路径。
// 字典项扩展属性的结构在同目录的 dict-ext.ts。
import { IdSchema } from "../common/scalars.js";
import { z } from "../zod.js";

import type { FlagValue, FlagValueType } from "./flags.js";

/** 字数：按码点数，一个汉字算一个 */
const chars = (text: string): number => [...text].length;
const unique = (list: readonly unknown[]): boolean => new Set(list).size === list.length;
/** 文字：去掉首尾空白后 1–max 个字 */
const text = (max: number) =>
  z
    .string()
    .refine((value) => value.trim() !== "" && chars(value) <= max, `须为 1–${String(max)} 个字`);

// ---------- 开关规则（14 分组 第 4.6 节） ----------

/**
 * 客户端版本范围：用空格连起来的比较式，全部满足才算命中，如 ">=1.2.0 <2.0.0"。
 * 比较符只有 >=、>、<=、<、=；版本号是三段数字。不引 semver 库，不支持 ^、~、||、预发布标记。
 */
export const VERSION_RANGE_PATTERN =
  /^(?:>=|<=|>|<|=)\d{1,5}\.\d{1,5}\.\d{1,5}(?: (?:>=|<=|>|<|=)\d{1,5}\.\d{1,5}\.\d{1,5})*$/;

/** 小程序的运行环境：开发版、体验版、正式版（请求头 X-Env-Version） */
export const ENV_VERSIONS = ["develop", "trial", "release"] as const;
export type EnvVersion = (typeof ENV_VERSIONS)[number];

/** 规则的条件：平台、客户端版本、环境、主体白名单四种，写了的都满足才命中；至少写一种 */
export const FlagRuleWhenSchema = z
  .strictObject({
    platform: z.array(z.string().min(1).max(32)).min(1).optional(),
    clientVersion: z.string().regex(VERSION_RANGE_PATTERN, "版本范围写法不对").optional(),
    envVersion: z.array(z.enum(ENV_VERSIONS)).min(1).optional(),
    entityIds: z.array(IdSchema).min(1).max(500).optional(),
  })
  .refine((when) => Object.keys(when).length > 0, "规则至少要有一个条件");
export type FlagRuleWhen = z.infer<typeof FlagRuleWhenSchema>;

/** 一条规则：命中即返回 value。value 的类型要与开关的值类型相同，由 isFlagValueOfType 另查 */
export const FlagRuleSchema = z.strictObject({ when: FlagRuleWhenSchema, value: z.json() });
export type FlagRule = z.infer<typeof FlagRuleSchema>;

/** feature_flag.rules：有序数组，首条命中即返回 */
export const FlagRulesSchema = z.array(FlagRuleSchema).max(50);

/** 一个值合不合开关的值类型（ck_feature_flag_default_value）：bool 是布尔，enum 是字符串，json 不限 */
export function isFlagValueOfType(valueType: FlagValueType, value: unknown): value is FlagValue {
  if (valueType === "bool") return typeof value === "boolean";
  if (valueType === "enum") return typeof value === "string";
  return value !== undefined;
}

// ---------- 清单条目（14 分组 第 4.7 节） ----------

export const ChecklistItemSchema = z.strictObject({
  /** 同一模板内唯一；业务记录的结果数组按它对应 */
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "条目键须为字母开头的字母、数字、下划线"),
  label: text(100),
  required: z.boolean(),
  allowNa: z.boolean(),
  /** 向商家展示的质检结果只取为真的条目 */
  merchantVisible: z.boolean(),
  hint: text(200).optional(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

/** checklist_template.items。草稿可以为空；启用时至少一条由库的 CHECK 把关 */
export const ChecklistItemsSchema = z
  .array(ChecklistItemSchema)
  .max(100)
  .refine((items) => unique(items.map((item) => item.key)), "条目键不能重复");

// ---------- 站点配置（14 分组 第 4.3 节） ----------

/** 分类与分档的 key：配置内唯一，改名不换 key */
const ConfigKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "key 须为小写字母开头的蛇形");
/** 字典编码的写法（ck_dict_item_code） */
export const DictCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/, "字典编码写法不对");

export const MallCategorySchema = z.strictObject({
  key: ConfigKeySchema,
  name: text(4),
  /** 字典 genre 的编码；“全部”为空数组，表示全部在架短剧 */
  genreCodes: z.array(DictCodeSchema),
  visible: z.boolean(),
  fixed: z.boolean(),
});
export type MallCategory = z.infer<typeof MallCategorySchema>;

/** 集数、积分价的一档：闭区间，min、max 不能都为空 */
export const MallBandSchema = z
  .strictObject({
    key: ConfigKeySchema,
    label: text(10),
    min: z.int().min(0).nullable(),
    max: z.int().min(0).nullable(),
  })
  .refine((band) => band.min !== null || band.max !== null, "min、max 不能都为空")
  .refine((band) => band.min === null || band.max === null || band.min <= band.max, "min 须 ≤ max");
export type MallBand = z.infer<typeof MallBandSchema>;

const MallBandsSchema = z
  .array(MallBandSchema)
  .max(6)
  .refine((bands) => unique(bands.map((band) => band.key)), "分档的 key 不能重复")
  .refine((bands) => unique(bands.map((band) => band.label)), "分档不能重名");

export const MALL_SORTS = ["composite", "heat", "price_asc", "price_desc", "newest"] as const;
export type MallSort = (typeof MALL_SORTS)[number];

/** config_key = mall 的整份内容 */
export const MallConfigSchema = z
  .strictObject({
    categories: z.array(MallCategorySchema).min(1).max(10),
    hotWords: z.array(text(8)).max(8),
    filters: z.strictObject({
      genre: z.boolean(),
      industry: z.boolean(),
      episodes: z.boolean(),
      price: z.boolean(),
      episodeBands: MallBandsSchema,
      priceBands: MallBandsSchema,
    }),
    sorts: z
      .array(z.enum(MALL_SORTS))
      .min(1)
      .refine((sorts) => unique(sorts), "排序项不能重复"),
    defaultSort: z.enum(MALL_SORTS),
    /** 综合排序权重，合计 100；manual 对应 drama.manual_boost */
    weights: z.strictObject({
      heat: z.int().min(0).max(100),
      sales30d: z.int().min(0).max(100),
      freshness: z.int().min(0).max(100),
      manual: z.int().min(0).max(100),
    }),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string, path: PropertyKey[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };
    const { categories, filters, weights } = config;
    if (!unique(config.hotWords)) issue("热词不能重复", ["hotWords"]);
    if (!config.sorts.includes(config.defaultSort))
      issue("默认排序须在可选排序中", ["defaultSort"]);
    if (!unique(categories.map((item) => item.key))) issue("分类的 key 不能重复", ["categories"]);
    if (!unique(categories.map((item) => item.name))) issue("分类不能重名", ["categories"]);
    const fixed = categories.filter((item) => item.fixed);
    const [first] = categories;
    if (fixed.length !== 1 || first?.fixed !== true) {
      issue("恰好一个固定分类，且排第一", ["categories"]);
    } else if (first.key !== "all" || !first.visible || first.genreCodes.length > 0) {
      issue("固定分类的 key 是 all、不可隐藏、genreCodes 为空", ["categories", 0]);
    }
    categories.forEach((item, index) => {
      if (item.fixed) return;
      if (item.genreCodes.length === 0 || !unique(item.genreCodes)) {
        issue("genreCodes 至少 1 个且不重复", ["categories", index, "genreCodes"]);
      }
    });
    if (filters.episodes && filters.episodeBands.length === 0) {
      issue("开了集数筛选至少要 1 档", ["filters", "episodeBands"]);
    }
    if (filters.price && filters.priceBands.length === 0) {
      issue("开了积分价筛选至少要 1 档", ["filters", "priceBands"]);
    }
    if (weights.heat + weights.sales30d + weights.freshness + weights.manual !== 100) {
      issue("四项权重合计须为 100", ["weights"]);
    }
  });
export type MallConfig = z.infer<typeof MallConfigSchema>;

/** config_key = home_recommend 的整份内容 */
export const HomeRecommendConfigSchema = z.strictObject({
  recommendCount: z.int().min(3).max(12),
  /** 按行业置顶：行业是字典 industry 的一级编码，每个行业至多 1 部 */
  pins: z
    .array(z.strictObject({ industryCode: DictCodeSchema, dramaId: IdSchema }))
    .max(50)
    .refine((pins) => unique(pins.map((pin) => pin.industryCode)), "每个行业至多置顶 1 部"),
  defaultTab: z.enum(["hot", "new"]),
  newDays: z.int().min(7).max(90),
});
export type HomeRecommendConfig = z.infer<typeof HomeRecommendConfigSchema>;

/** 配置键 → 内容的结构（site_config_revision.content） */
export const SITE_CONFIG_SCHEMAS = {
  mall: MallConfigSchema,
  home_recommend: HomeRecommendConfigSchema,
} as const;
/** 各配置键的内容类型 */
export interface SiteConfigContent {
  mall: MallConfig;
  home_recommend: HomeRecommendConfig;
}
