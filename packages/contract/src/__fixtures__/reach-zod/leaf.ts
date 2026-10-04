// 三种引法都要扫得出来：只在类型上的 import、只为副作用的 import、动态 import
import type { ZodType } from "zod";
import "@hono/zod-openapi";

export const LEAF_NAME = "leaf";
export type LeafSchema = ZodType;
export const loadHono = () => import("hono");
