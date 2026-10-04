// 契约自测的夹具：三组各一条样例路由，另加一条回调路由与一条探活登记（任务书 W0-08 第 11 节第 1 项）。
// 只给测试用：不从包入口导出，不进 allRoutes，不进提交的生成物。名字带 fixture，免得与真实资源混淆。
import { z } from "../zod.js";

import {
  CursorQuerySchema,
  DictRefSchema,
  FenSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  cursorPage,
  errorResponses,
  okResponse,
  openEnum,
  orNull,
  sortQuery,
} from "../common/index.js";
import {
  adminRoute,
  defineRouteRegistry,
  hookRoute,
  merchantRoute,
  portalRoute,
  registryOnly,
} from "../routes/index.js";

/** 开放枚举的夹具：生成的类型应是 "draft" | "live" | (string & {}) */
export const FixtureStatusSchema = openEnum(["draft", "live"]);

export const FixtureThingSchema = z
  .object({
    id: IdSchema,
    status: FixtureStatusSchema,
    previousStatus: orNull(FixtureStatusSchema),
    category: orNull(DictRefSchema),
    tags: z.array(DictRefSchema),
    priceFen: FenSchema,
    createdAt: InstantSchema,
  })
  .openapi("FixtureThing");

const ThingParams = z.object({ fixtureThingId: IdSchema });

/** 商家端：写路由，路径里带参数 */
export const sampleMerchantRoute = merchantRoute({
  method: "patch",
  path: "/m/fixture-things/{fixtureThingId}",
  operationId: "m.fixtureThing.update",
  summary: "夹具：改一条",
  "x-capability": "fixture.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: ThingParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ priceFen: FenSchema }) } },
    },
  },
  responses: { ...okResponse(FixtureThingSchema), ...errorResponses(400, 404, 409) },
});

/** 后台：页码分页的列表，不设权限点 */
export const sampleAdminRoute = adminRoute({
  method: "get",
  path: "/admin/fixture-things",
  operationId: "admin.fixtureThing.list",
  summary: "夹具：列表",
  "x-permission": null,
  request: {
    query: PageQuerySchema.extend({ sort: sortQuery(["createdAt", "priceFen"], "-createdAt") }),
  },
  responses: okResponse(
    z.object({
      items: z.array(FixtureThingSchema),
      page: z.int(),
      pageSize: z.int(),
      total: z.int(),
    }),
  ),
});

/** 下载页：游标分页 */
export const samplePortalRoute = portalRoute({
  method: "get",
  path: "/portal/fixture-things",
  operationId: "portal.fixtureThing.list",
  summary: "夹具：游标列表",
  "x-auth": "portal",
  request: { query: CursorQuerySchema },
  responses: okResponse(cursorPage(FixtureThingSchema)),
});

/** 回调：不出文档 */
export const sampleHookRoute = hookRoute({
  method: "post",
  path: "/hooks/fixture/events",
  operationId: "hooks.fixture.event.receive",
  summary: "夹具：回调收件",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_fixture_event_provider_event_id"],
  responses: { 200: { description: "按 Provider 协议应答" } },
});

/** 探活：只登记 */
export const sampleProbe = registryOnly({
  registryKey: "hooks.healthz.get",
  path: "/healthz",
  summary: "夹具：存活检查",
});

/** 反例：导出了却没登记 */
export const orphanRoute = merchantRoute({
  method: "get",
  path: "/m/fixture-orphans",
  operationId: "m.fixtureOrphan.list",
  "x-clerk-view": "same",
  responses: okResponse(z.object({ items: z.array(FixtureThingSchema) })),
});

export const sampleRegistry = defineRouteRegistry({
  routes: [sampleMerchantRoute, sampleAdminRoute, samplePortalRoute, sampleHookRoute],
  registryOnly: [sampleProbe],
});
