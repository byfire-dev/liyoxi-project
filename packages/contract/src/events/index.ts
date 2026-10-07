// 出站事件的载荷结构（EventPayload[event_type]，01 分组 第 4 节；x01 第 2.3 节 P1）。带 Zod 运行时，只经包入口给出。
// 事件名、聚合、状态登记在 ./registry（纯常量）；这里只放载荷的 schema，按事件名取。
// 一个模块一个文件，各导出一个 payloads；各域发事件之前先在这里交 schema（计划 第 5.3 节“契约先行”）：
// 加一个模块文件，在下面 import 并展开进 EVENT_PAYLOAD_SCHEMAS。没有 schema 的事件 events.emit() 不给发。
import { payloads as content } from "./content.js";
import { payloads as delivery } from "./delivery.js";
import { payloads as order } from "./order.js";
import { payloads as media } from "./media.js";
import type { EventName } from "../registry/index.js";
import type { z } from "../zod.js";
import { payloads as config } from "./config.js";
import { payloads as billing } from "./billing.js";
import { payloads as identity } from "./identity.js";
import { payloads as sla } from "./sla.js";
import { payloads as staff } from "./staff.js";
import { payloads as tenant } from "./tenant.js";
import { payloads as approval } from "./approval.js";
import { payloads as publish } from "./publish.js";
import { payloads as profile } from "./profile.js";
import { payloads as security } from "./security.js";

/** 已交 schema 的事件：事件名 → 载荷 schema。键必须是事件目录里的名字 */
export const EVENT_PAYLOAD_SCHEMAS = {
  ...content,
  ...delivery,
  ...order,
  ...media,
  ...sla,
  ...tenant,
  ...config,
  ...staff,
  ...approval,
  ...billing,
  ...identity,
  ...profile,
  ...publish,
  ...security,
} as const satisfies Partial<Record<EventName, z.ZodType>>;

/** 已交 schema 的事件名 */
export type EventPayloadName = keyof typeof EVENT_PAYLOAD_SCHEMAS;
/** 某个事件的载荷类型 */
export type EventPayloadOf<N extends EventPayloadName> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[N]>;

/** 按事件名取载荷 schema；这个事件还没交 schema 即 undefined */
export function eventPayloadSchema(eventType: string): z.ZodType | undefined {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, eventType)
    ? EVENT_PAYLOAD_SCHEMAS[eventType as EventPayloadName]
    : undefined;
}
