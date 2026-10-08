import type { operations } from "@liyoxi/contract/types/admin";
import { CHECKLIST_TEMPLATE_CODE } from "@liyoxi/contract/enums";
import {
  ChecklistTemplateCreateBodySchema,
  DictItemCreateBodySchema,
  DictItemUpdateBodySchema,
  FeatureFlagUpdateBodySchema,
  dictExtSchema,
} from "@liyoxi/contract";
import { atMinuteOfDay, calendarDate, isLocalDate, parseHm } from "@liyoxi/shared/time";

import { newIdempotencyKey } from "../../../lib/idempotency";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";

type Result<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer T } } } };
}
  ? T
  : never;
type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type DictType = Result<"admin.dictType.list">["items"][number];
export type DictItem = Result<"admin.dictItem.list">["items"][number];
export type ParamList = Result<"admin.paramValue.list">;
export type Param = ParamList["items"][number];
export type Flag = Result<"admin.featureFlag.list">["items"][number];
export type Checklist = Result<"admin.checklistTemplate.list">["items"][number];
export type Calendar = Result<"admin.calendarDay.list">;
export type CalendarResult = Result<"admin.calendarDay.batchImport">;
export type ParamBody = Body<"admin.paramValue.replace">;
export type FlagBody = Body<"admin.featureFlag.update">;
export type ChecklistBody = Body<"admin.checklistTemplate.create">;
export type DictCreateBody = Body<"admin.dictItem.create">;
export type DictUpdateBody = Body<"admin.dictItem.update">;
export type Json = ParamBody["items"][number]["value"];
export type FieldErrors = Record<string, string>;
export const CONFIG_KEY = ["system", "config"] as const;
export const CHECKLIST_CODES = CHECKLIST_TEMPLATE_CODE.values;

const text = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;
export function dictSearch(raw: Record<string, unknown>) {
  return {
    type: text(raw.type, /^[a-z][a-z0-9_]{0,39}$/),
    id: text(raw.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i),
    q: typeof raw.q === "string" ? raw.q.trim().slice(0, 40) || undefined : undefined,
    disabled: raw.disabled === "true" ? ("true" as const) : undefined,
  };
}
export function paramsSearch(raw: Record<string, unknown>, now = new Date()) {
  const year = Number(raw.year);
  return {
    group: text(raw.group, /^[a-z][a-z0-9_]{0,39}$/),
    year:
      Number.isSafeInteger(year) && year >= 2024 && year <= 2100
        ? year
        : Number(calendarDate(now).slice(0, 4)),
  };
}
export function configTableSearch(raw: Record<string, unknown>, checklist = false): TableSearch {
  const search = readTableSearch(raw, checklist ? ["code", "status"] : []);
  const filters: Record<string, string> = {};
  if (checklist && CHECKLIST_CODES.some((code) => code === search.filters.code))
    filters.code = search.filters.code!;
  if (checklist && ["draft", "active", "retired"].includes(search.filters.status ?? ""))
    filters.status = search.filters.status!;
  return { ...search, filters, sort: undefined, tab: undefined, q: search.q?.slice(0, 60) };
}
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
export function valueText(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value) ?? "—";
}
export function parseJson(value: string): { value?: Json; error?: string } {
  try {
    return { value: JSON.parse(value) as Json };
  } catch {
    return { error: "请填写合法 JSON" };
  }
}
function schemaErrors(issues: { path: PropertyKey[]; message: string }[]): FieldErrors {
  return Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.message]));
}
export interface DictDraft {
  name: string;
  description: string;
  tags: string;
  ext: string;
  parentCode: string | null;
}
export function dictDraft(item?: DictItem): DictDraft {
  return {
    name: item?.name ?? "",
    description: item?.description ?? "",
    tags: item?.tags.join("、") ?? "",
    ext: jsonText(item?.ext ?? {}),
    parentCode: item?.parentCode ?? null,
  };
}
export function dictDepth(item: DictItem, items: readonly DictItem[]): number {
  let depth = 1,
    parent = item.parentCode;
  const seen = new Set([item.code]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = items.find((row) => row.code === parent)?.parentCode ?? null;
  }
  return depth;
}
export function dictCanDisable(type: DictType, item: DictItem): boolean {
  return !type.isSystem && type.disablePolicy !== "never" && item.isEnabled;
}
export function dictBody(
  type: DictType,
  draft: DictDraft,
  item?: DictItem,
): { body?: DictCreateBody | DictUpdateBody; errors: FieldErrors } {
  const basic = { name: draft.name.trim(), description: draft.description.trim() || null };
  const ext = parseJson(draft.ext);
  if (!item && !type.canCreate) return { errors: { name: "此类型不允许新增" } };
  if (!type.isSystem) {
    if (ext.error) return { errors: { ext: ext.error } };
    const parsed = dictExtSchema(type.typeKey).safeParse(ext.value);
    if (!parsed.success)
      return {
        errors: Object.fromEntries(
          Object.entries(schemaErrors(parsed.error.issues)).map(([key, value]) => [
            `ext${key ? `.${key}` : ""}`,
            value,
          ]),
        ),
      };
  }
  const extra = type.isSystem
    ? {}
    : {
        tags: draft.tags
          .split(/[、,]/)
          .map((v) => v.trim())
          .filter(Boolean),
        ext: ext.value,
      };
  const input = item
    ? { lockVersion: item.lockVersion, ...basic, ...extra }
    : { typeKey: type.typeKey, parentCode: draft.parentCode, ...basic, ...extra };
  const parsed = (item ? DictItemUpdateBodySchema : DictItemCreateBodySchema).safeParse(input);
  return parsed.success
    ? { body: parsed.data as DictCreateBody | DictUpdateBody, errors: {} }
    : { errors: schemaErrors(parsed.error.issues) };
}
export interface ParamDraft {
  value: Json;
  expectedRev: string | null;
}
export function paramDraft(item: Param): ParamDraft {
  return { value: item.value as Json, expectedRev: item.latestRev };
}
export function paramDraftValue(item: Param, drafts: Readonly<Record<string, ParamDraft>>): Json {
  const draft = drafts[item.key];
  return draft === undefined ? (item.value as Json) : draft.value;
}
export function paramIssue(item: Param, value: Json): string | undefined {
  if (value === null) return item.defaultValue === null ? undefined : "此参数不能设为空";
  if (item.type === "int" || item.type === "bp") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return "请填写整数";
    const min = item.range?.min,
      max = item.range?.max;
    if (typeof min === "number" && value < min) return `最小值为 ${min}`;
    if (typeof max === "number" && value > max) return `最大值为 ${max}`;
  } else if (item.type === "bool" && typeof value !== "boolean") return "请选择是或否";
  else if (item.type === "time_hm") {
    try {
      if (typeof value !== "string" || parseHm(value) >= 1440) return "请填写 HH:mm 时刻";
    } catch {
      return "请填写 HH:mm 时刻";
    }
  } else if (item.type === "enum") {
    const options = item.range?.options;
    if (typeof value !== "string" || !Array.isArray(options) || !options.includes(value))
      return "请选择已有选项";
  } else if (item.type === "text" && typeof value !== "string") return "请填写文字";
  else if (
    item.type === "int_list" &&
    (!Array.isArray(value) || !value.every((v) => typeof v === "number" && Number.isSafeInteger(v)))
  )
    return "请填写整数数组";
  else if (
    item.type === "sla_policy" &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  )
    return "请填写时限策略对象";
  return undefined;
}
/** 日期与时间在界面明确是北京时间，不经浏览器本地时区。 */
export function scheduleInstant(date: string, hm: string): string {
  if (!isLocalDate(date)) throw new Error("请选择有效生效日期");
  const minute = parseHm(hm);
  if (minute >= 1440) throw new Error("请选择有效生效时间");
  return atMinuteOfDay(date, minute).toISOString();
}
export function paramBody(
  items: readonly Param[],
  drafts: Readonly<Record<string, ParamDraft>>,
  effectiveAt?: string,
  reason = "",
): { body?: ParamBody; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const changes = Object.entries(drafts).map(([key, draft]) => {
    const item = items.find((row) => row.key === key);
    const issue = item ? paramIssue(item, draft.value) : "参数已不存在，请刷新";
    if (issue) errors[key] = issue;
    return {
      key,
      value: draft.value,
      expectedRev: draft.expectedRev,
      ...(effectiveAt ? { effectiveAt } : {}),
    };
  });
  const work = (key: string) => drafts[key]?.value ?? items.find((row) => row.key === key)?.value;
  const start = work("work.start"),
    end = work("work.end");
  if (typeof start === "string" && typeof end === "string" && start >= end)
    errors["work.end"] = "上班时刻必须早于下班时刻";
  if (!changes.length) errors.form = "请先修改参数";
  if (reason.length > 100) errors.reason = "说明不超过100字";
  return Object.keys(errors).length
    ? { errors }
    : { body: { items: changes, ...(reason.trim() ? { reason: reason.trim() } : {}) }, errors };
}
/** 冲突后保留可识别的草稿，只有用户再次确认才采用刚读取的最新版本。 */
export function acknowledgeParamVersions(
  drafts: Readonly<Record<string, ParamDraft>>,
  items: readonly Param[],
): Record<string, ParamDraft> {
  return Object.fromEntries(
    Object.entries(drafts).map(([key, draft]) => [
      key,
      { ...draft, expectedRev: items.find((item) => item.key === key)?.latestRev ?? null },
    ]),
  );
}
export function flagBody(
  flag: Flag,
  defaults: Json,
  rulesText: string,
  description: string,
): { body?: FlagBody; errors: FieldErrors } {
  const rules = parseJson(rulesText);
  if (rules.error) return { errors: { rules: rules.error } };
  const values = [
    defaults,
    ...(Array.isArray(rules.value)
      ? rules.value.map((rule) =>
          typeof rule === "object" && rule !== null && !Array.isArray(rule) && "value" in rule
            ? rule.value
            : undefined,
        )
      : []),
  ];
  if (
    values.some((value) =>
      flag.valueType === "bool"
        ? typeof value !== "boolean"
        : flag.valueType === "enum"
          ? typeof value !== "string"
          : value === undefined,
    )
  )
    return { errors: { defaultValue: "默认值及规则值必须符合服务端返回的类型" } };
  const parsed = FeatureFlagUpdateBodySchema.safeParse({
    lockVersion: flag.lockVersion,
    defaultValue: defaults,
    rules: rules.value,
    description,
  });
  return parsed.success
    ? { body: parsed.data as FlagBody, errors: {} }
    : { errors: schemaErrors(parsed.error.issues) };
}
export function checklistBody(
  code: string,
  items: unknown,
): { body?: ChecklistBody; errors: FieldErrors } {
  const parsed = ChecklistTemplateCreateBodySchema.safeParse({ code, items });
  return parsed.success
    ? { body: parsed.data as ChecklistBody, errors: {} }
    : { errors: schemaErrors(parsed.error.issues) };
}
/** 退役是独立且不可撤销的一步；创建改稿不能换退役键，未知响应只用原键回放。 */
export function createChecklistDiscardIntent(source?: Checklist) {
  const id = source?.status === "draft" ? source.checklistTemplateId : undefined;
  const key = newIdempotencyKey("checklist-discard");
  let completed = false;
  return async (discard: (id: string, key: string) => Promise<unknown>) => {
    if (!id || completed) return;
    await discard(id, key);
    completed = true;
  };
}
/** 相同 body 重试沿用键；用户实质改动后更换键，同步挡住重复提交。 */
export function createConfigIntent(action: string, makeKey = () => newIdempotencyKey(action)) {
  let signature: string | undefined,
    key = makeKey(),
    running = false;
  return {
    async submit<T>(body: unknown, send: (key: string) => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      const next = JSON.stringify(body);
      if (signature !== undefined && signature !== next) key = makeKey();
      signature = next;
      running = true;
      try {
        const result = await send(key);
        signature = undefined;
        key = makeKey();
        return result;
      } finally {
        running = false;
      }
    },
  };
}
