// 全包只从这里拿 z：zod 自己的 z，已挂上 .openapi()（与 @hono/zod-openapi 导出的 z 是同一个对象）。
// 特意直接写出对 zod 的 import：依赖方向检查（weapp-no-zod、shared-no-zod）按“能不能走到 zod”来拦，
// 而 @hono/zod-openapi 解析到它的 dist/ 目录，被该检查的排除项滤掉了，只经它引 z 的话检查看不见。
// 所以下面对 zod 的那行 import 不能删（契约自测钉住了它；见状态文件 W0-08 偏差 6）。
//
// 另：本文件在模块顶层调 extendZodWithOpenApi，所以从包入口引 Zod 结构会把 @hono/zod-openapi 一并带进去。
// 后台与下载页接入（W0-28）时留意包体积；需要的话由后续包加一个只含 Zod 结构的子路径。
import { extendZodWithOpenApi } from "@hono/zod-openapi";
import { z } from "zod";

// 可重入：已经挂过就什么都不做
extendZodWithOpenApi(z);

export { z };
