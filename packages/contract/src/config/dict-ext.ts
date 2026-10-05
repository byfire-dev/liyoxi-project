// 字典项扩展属性 dict_item.ext 的结构，按字典类型（W0-18）。依据：14 分组 第 4.1 节；m08 第 3.2 节（小程序白名单）。
// 没列出的类型（genre、selling_tag、plan_tier、point_type 等）扩展属性是空对象。
// 带 Zod：只从包入口给出。
import { z } from "../zod.js";

import { DictCodeSchema } from "./schemas.js";

const camelKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/, "键须为小驼峰");

/** 行业品类。特殊行业（special）不可开放 */
export const IndustryExtSchema = z
  .strictObject({
    open: z.boolean(),
    special: z.boolean(),
    /** 须提供的许可证：字典 permit_type 的编码 */
    requiredCerts: z.array(DictCodeSchema),
  })
  .refine((ext) => !(ext.special && ext.open), "特殊行业不可设为开放");

export const RegionExtSchema = z.strictObject({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  functionalZone: z.boolean(),
  opened: z.boolean(),
});

export const REJECT_REASON_SCENES = [
  "store_review",
  "link_verify",
  "account_verify",
  "invoice",
  "point_adjust",
  "transfer",
  "cancel_refund",
] as const;
export const RejectReasonExtSchema = z.strictObject({ scene: z.enum(REJECT_REASON_SCENES) });

/** 工单类型：四个键都必填；只有 isAfterSales 对小程序下发 */
export const TicketTypeExtSchema = z.strictObject({
  defaultPriority: z.enum(["high", "mid", "low"]),
  transferable: z.boolean(),
  notifyLead: z.boolean(),
  isAfterSales: z.boolean(),
});

export const AssetTagExtSchema = z.strictObject({
  dimension: z.enum(["content", "usage", "timeliness"]),
});

export const PermitFieldDefSchema = z.strictObject({
  key: camelKey,
  label: z.string().min(1).max(40),
  sensitive: z.boolean(),
  format: z.enum(["text", "date", "cert_no"]),
});

/** 行业许可证类型：识别与提交只认 fields 里的键；各 *Key 指向 fields 里的键 */
export const PermitTypeExtSchema = z
  .strictObject({
    fields: z.array(PermitFieldDefSchema).min(1).max(20),
    holderNameKey: camelKey,
    certNoKey: camelKey,
    /** 编号格式正则 */
    certNoPattern: z.string().min(1).max(100).nullable(),
    principalNameKey: camelKey.nullable(),
    validFromKey: camelKey.nullable(),
    validToKey: camelKey.nullable(),
  })
  .superRefine((ext, ctx) => {
    const keys = ext.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "fields 的 key 不能重复", path: ["fields"] });
    }
    for (const name of [
      "holderNameKey",
      "certNoKey",
      "principalNameKey",
      "validFromKey",
      "validToKey",
    ] as const) {
      const key = ext[name];
      if (key !== null && !keys.includes(key)) {
        ctx.addIssue({ code: "custom", message: "须指向 fields 里的键", path: [name] });
      }
    }
    if (ext.certNoPattern !== null) {
      try {
        new RegExp(ext.certNoPattern);
      } catch {
        ctx.addIssue({ code: "custom", message: "不是合法的正则", path: ["certNoPattern"] });
      }
    }
  });
export type PermitTypeExt = z.infer<typeof PermitTypeExtSchema>;

/** 门店卖点：适用的二级品类编码，空数组即适用全部品类 */
export const StoreSellingPointExtSchema = z.strictObject({
  categoryCodes: z.array(DictCodeSchema),
});

/** 没有扩展属性的类型 */
export const EmptyExtSchema = z.strictObject({});

/** 有扩展属性的字典类型 → 结构 */
export const DICT_EXT_SCHEMAS = {
  industry: IndustryExtSchema,
  region: RegionExtSchema,
  reject_reason: RejectReasonExtSchema,
  ticket_type: TicketTypeExtSchema,
  asset_tag: AssetTagExtSchema,
  permit_type: PermitTypeExtSchema,
  store_selling_point: StoreSellingPointExtSchema,
} as const;

/** 取一个字典类型的扩展属性结构；没登记的类型是空对象 */
export function dictExtSchema(typeKey: string): z.ZodType<Record<string, unknown>> {
  return Object.hasOwn(DICT_EXT_SCHEMAS, typeKey)
    ? DICT_EXT_SCHEMAS[typeKey as keyof typeof DICT_EXT_SCHEMAS]
    : EmptyExtSchema;
}

/**
 * 对小程序公开的扩展属性键（m08 第 3.2 节）。没列出的类型一个键都不下发。
 * industry 的 open、region 的 opened 不下发：缺省只下发可选的项，它们已经用在过滤上。
 */
export const MERCHANT_DICT_EXT_KEYS: Readonly<Record<string, readonly string[]>> = {
  industry: ["special", "requiredCerts"],
  region: ["level", "functionalZone"],
  asset_tag: ["dimension"],
  store_selling_point: ["categoryCodes"],
  permit_type: [
    "fields",
    "holderNameKey",
    "certNoKey",
    "certNoPattern",
    "principalNameKey",
    "validFromKey",
    "validToKey",
  ],
  ticket_type: ["isAfterSales"],
};

/**
 * 新选择时还要看扩展属性的类型：行业要开放、区划要已开通（m08 第 2.3 节的 isSelectable）。
 * 值是 ext 里那个布尔键的名字。
 */
export const DICT_SELECTABLE_EXT_FLAG: Readonly<Record<string, string>> = {
  industry: "open",
  region: "opened",
};
