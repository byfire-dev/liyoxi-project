import { calendarDate, minuteOfDay } from "@liyoxi/shared/time";
import { fenToYuan } from "@liyoxi/shared/format/money";
import type { NotifyFact } from "./context.js";
import type { SMS_TODO_ITEMS } from "../providers/types.js";
import { textLimit } from "./policy.js";

const progress = new Map([
  ["pending_confirm", "待确认"],
  ["pushed", "待确认"],
  ["confirmed", "已确认"],
  ["approved", "已通过"],
  ["rejected", "未通过"],
  ["accepted", "已采纳"],
  ["paid", "已付款"],
  ["producing", "制作中"],
  ["pending_start", "待开工"],
  ["available", "已通过"],
  ["abnormal", "待处理"],
  ["delivered", "已交付"],
]);

const fieldNames: Readonly<Record<string, readonly string[]>> = {
  service_progress: ["thing1", "phrase2", "thing3"],
  order_result: ["thing1", "character_string1", "thing2", "thing3"],
  pay_result: ["character_string1", "amount2", "phrase3", "time4"],
  quota_change: ["thing1", "number2", "number3"],
  review_result: ["thing1", "phrase2", "thing3"],
  asset_feedback: ["thing1", "phrase2", "thing3"],
};
/** A configured field is an explicit expression, not an arbitrary label or property path. */
export function validWechatFields(slot: string, fields: unknown): boolean {
  if (
    !Object.hasOwn(fieldNames, slot) ||
    !Array.isArray(fields) ||
    fields.length < 1 ||
    fields.length > 20
  )
    return false;
  const used = new Set<string>();
  return fields.every((field) => {
    if (
      !field ||
      typeof field !== "object" ||
      Array.isArray(field) ||
      typeof field.name !== "string" ||
      typeof field.type !== "string" ||
      !fieldNames[slot]!.includes(field.name) ||
      used.has(field.name) ||
      /^(thing|phrase|character_string|number|time|amount)\d+$/.exec(field.name)?.[1] !== field.type
    )
      return false;
    used.add(field.name);
    return true;
  });
}

/** Fixed expressions, not a label evaluator. Unknown field names never acquire invented values. */
export function renderWechat(
  slot: string,
  fields: unknown,
  fact: NotifyFact,
): Record<string, string> | null {
  const values: Record<string, string | undefined> = {};
  const state = progress.get(fact.status) ?? "查看详情";
  switch (slot) {
    case "service_progress":
      Object.assign(values, { thing1: fact.name, phrase2: state, thing3: "请进入小程序查看详情" });
      break;
    case "order_result":
      Object.assign(values, {
        thing1: fact.name,
        character_string1: fact.name,
        thing2: "短剧定制",
        thing3: "订购成功，请查看交付进度",
      });
      break;
    case "pay_result":
      Object.assign(values, {
        character_string1: fact.name,
        amount2: fact.amountFen === undefined ? undefined : fenToYuan(fact.amountFen),
        phrase3: "已付款",
        time4: fact.occurredAt,
      });
      break;
    case "quota_change":
      Object.assign(values, {
        thing1: fact.detail,
        number2: fact.quantity?.toString(),
        number3: fact.balance?.toString(),
      });
      break;
    case "review_result":
      Object.assign(values, { thing1: fact.name, phrase2: state, thing3: "请查看审核详情" });
      break;
    case "asset_feedback":
      Object.assign(values, { thing1: fact.name, phrase2: "已采用", thing3: "素材已用于定制内容" });
      break;
    default:
      return null; // Future slots acquire their rendering when their real producer lands.
  }
  if (!validWechatFields(slot, fields) || !Array.isArray(fields)) return null;
  const result: Record<string, string> = {};
  for (const field of fields) {
    if (
      !field ||
      typeof field !== "object" ||
      Array.isArray(field) ||
      typeof field.name !== "string" ||
      typeof field.type !== "string" ||
      !Object.hasOwn(values, field.name) ||
      Object.hasOwn(result, field.name)
    )
      return null;
    const value = values[field.name];
    const kind = /^(thing|phrase|character_string|number|time|amount)\d+$/.exec(field.name)?.[1];
    if (!value || kind !== field.type) return null;
    if (kind === "number" && !/^-?\d+$/.test(value)) return null;
    if (kind === "amount" && !/^\d+\.\d{2}$/.test(value)) return null;
    const instant = kind === "time" ? new Date(value) : null;
    if (instant && !Number.isFinite(instant.getTime())) return null;
    const minute = instant ? minuteOfDay(instant) : 0;
    result[field.name] = instant
      ? `${calendarDate(instant)} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
      : textLimit(value, kind === "phrase" ? 5 : kind === "thing" ? 20 : 32);
  }
  return result;
}

// Group13 actual generic bindings; editable scene names never become reported enum values.
const smsTodoByScene: ReadonlyMap<string, (typeof SMS_TODO_ITEMS)[number]> = new Map([
  ["m.pay_success", "付款成功"],
  ["m.order_submitted", "订购成功"],
  ["m.plan_pending", "方案确认"],
  ["m.delivered", "成片交付"],
  ["m.verify_result", "上线确认"],
  ["m.ticket_reply", "工单回复"],
  ["m.invoice_issued", "发票开具"],
  ["m.points_changed", "积分变动"],
  ["m.member_changed", "成员变动"],
  ["m.asset_feedback", "素材反馈"],
  ["m.refund_result", "退款结果"],
]);

export function renderSms(
  template: string,
  params: unknown,
  fact: NotifyFact,
  _title: string,
  sceneKey?: string,
): Record<string, string> | null {
  const todo = sceneKey === undefined ? undefined : smsTodoByScene.get(sceneKey);
  if (template === "generic_todo" && todo === undefined) return null;
  const values: Record<string, string> =
    template === "sample_pending"
      ? { item: "样片", matter: "样片", name: fact.name }
      : template === "generic_todo"
        ? { item: todo! }
        : template === "review_result"
          ? {
              result: progress.get(fact.status) ?? "请查看详情",
              reason: "请进入小程序查看审核详情",
            }
          : template === "account_notice"
            ? {}
            : {};
  if (!Array.isArray(params) || params.length > 20) return null;
  if (!params.length) return template === "account_notice" ? {} : null;
  const result: Record<string, string> = {};
  for (const param of params) {
    if (
      !param ||
      typeof param !== "object" ||
      Array.isArray(param) ||
      typeof param.name !== "string" ||
      !Number.isInteger(param.maxLen) ||
      param.maxLen < 1 ||
      param.maxLen > 100 ||
      !Object.hasOwn(values, param.name) ||
      Object.hasOwn(result, param.name)
    )
      return null;
    const value = values[param.name]!;
    if (template === "generic_todo" && [...value].length > param.maxLen) return null;
    result[param.name] = textLimit(value, param.maxLen);
  }
  return result;
}
