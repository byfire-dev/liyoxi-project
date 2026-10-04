// 标识与标量的 Zod 结构（约定 C29、C31–C35）。字段名后缀的约定见约定 C15。
import { z } from "../zod.js";

/** 小写、带连字符的 36 字符 UUID v7（约定 C29）。校验版本位与变体位；不按资源做品牌类型 */
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 标识：业务表主键，字段名以 Id 结尾 */
export const IdSchema = z
  .string()
  .regex(UUID_V7_PATTERN, "标识须为小写、带连字符的 UUID v7")
  .openapi({ format: "uuid" });
export type Id = z.infer<typeof IdSchema>;

/** 金额：整数分，字段名以 Fen 结尾（约定 C31）。跨主体的汇总金额用 BigIntStringSchema */
export const FenSchema = z.int();

/** 积分：整数，可带符号，字段名以 Points 结尾（约定 C32） */
export const PointsSchema = z.int();

/** 比例：万分比整数，字段名以 Bp 结尾，9 折 = 9000（约定 C32） */
export const BpSchema = z.int();

/** 库里是 bigint 的列：出接口为十进制字符串，字段名后缀不变（约定 C33） */
export const BigIntStringSchema = z.string().regex(/^-?\d+$/, "须为十进制整数字符串");

/** 时刻（输出）：UTC、毫秒三位、以 Z 结尾，即 Date.prototype.toISOString() 的结果（约定 C34） */
export const InstantSchema = z.iso.datetime({ precision: 3 });

/** 时刻（输入）：ISO 8601，接受任意偏移；不带偏移即拒绝（约定 C34） */
export const InstantInputSchema = z.iso.datetime({ offset: true });

/** 日期：YYYY-MM-DD，北京时间的“哪一天”，字段名以 Date 结尾（约定 C35） */
export const DateSchema = z.iso.date();

/** 月份：YYYY-MM（约定 C35） */
export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份须为 YYYY-MM");

/**
 * 可空的写法：响应里没有值写 null（约定 C38）。
 * 用联合而不用 .nullable()：后者会把具名组件连同它自己一起登记成可空。
 */
export function orNull<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.null()]);
}
