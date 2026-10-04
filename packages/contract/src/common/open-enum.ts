// 会增长的响应枚举（约定 C37）：标 x-open-enum，生成的类型是“已知值 | (string & {})”，端上必须有未知值的兜底。
// 类型转换只在 scripts/generate.ts 一处；后面的域包只调 openEnum()，不改生成脚本。
import { z } from "../zod.js";

/** OpenAPI 里的扩展键 */
export const OPEN_ENUM_KEY = "x-open-enum";

/** 手写类型时的同一形态：已知值之外还可能出现服务端新增的值 */
export type OpenEnum<T extends string> = T | (string & Record<never, never>);

/**
 * 声明一个会增长的响应枚举。服务端出站仍按已知值校验（新值先声明、下一版再写入），
 * 所以 Zod 一侧是闭集；开口只开在生成给端上的类型里。
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values).openapi({ [OPEN_ENUM_KEY]: true });
}
