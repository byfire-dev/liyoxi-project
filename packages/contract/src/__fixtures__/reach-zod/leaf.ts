// 几种引法都要扫得出来：只在类型上的 import、只为副作用的 import、动态 import（引号与模板字符串两种写法）
import type { ZodType } from "zod";
import "@hono/zod-openapi";

export const LEAF_NAME = "leaf";
export type LeafSchema = ZodType;
export const loadHono = () => import("hono");
export const loadZodMini = () => import(`zod/mini`);
// 参数不是字面量：静态扫描跟不过去，要被单列进 unresolved
export const loadByName = (name: string) => import(name);
