// audit.record（W0-14；03 分组 第 2.10 节；D4 第 8.2 节）：往 audit_log 写一行。单表三条流，只追加。
//   1. 只接受事务句柄，自己不开事务：审计行与业务写同事务，回滚则两者都不存在。
//   2. 永不因内容格式失败：文本先清洗、截断，before、after、meta 先清洗、脱敏、限长（sanitize.ts）。
//      会抛错的只有两类：数据库不可用（那时业务事务也该失败）；登记值与 id 不合法（代码缺陷，抛 TypeError）。
//   3. 列间关系按 03 分组 第 2.10 节的五条规范化规则写（操作人、命令行、对象、归属、会话），库里不写 CHECK。
//   4. id 由应用生成（UUID v7）；created_at、log_no 由库的插入触发器写，这里不传。
// 本模块只有写入；没有改、删的入口（库里另有触发器与授权两道）。查询与导出随 G2-A。
import {
  AUDIT_AUTH_METHODS,
  isAuditAction,
  isAuditCategory,
  isAuditTargetType,
} from "@liyoxi/contract";
import type {
  AuditAction,
  AuditAuthMethod,
  AuditCategory,
  AuditMetaFields,
  AuditTargetType,
} from "@liyoxi/contract";
import { AUDIT_LOG_STREAM } from "@liyoxi/contract/enums";
import type { EnumValue } from "@liyoxi/contract/enums";
import type { Prisma } from "@liyoxi/db";

import { isUuid, uuidv7 } from "../kernel/index.js";
import type { Actor, Tx } from "../kernel/index.js";
import { diffFields } from "./diff.js";
import { AUDIT_TEXT_LIMITS, capJson, cleanObject, clip, clipOrNull } from "./sanitize.js";

export type AuditStream = EnumValue<typeof AUDIT_LOG_STREAM>;

/**
 * 请求的元信息：路由层（任务处理器）必须传，没有就明写 null（D4 第 8.2 节第 7 条）。
 * 系统动作的会话、登录方式、IP、UA 由 record 自己定，传了也不用。
 */
export interface AuditRequestMeta {
  /** 请求追踪号；任务处理器沿用触发它的那个请求的 */
  readonly requestId: string | null;
  /** 可信 IP（解析在接口层） */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** 登录方式，取自会话 */
  readonly authMethod: AuditAuthMethod | null;
  /** 会话 id：商家 + weapp 是 user_session，商家 + portal 是 portal_session，员工 + admin 是 staff_session */
  readonly sessionId: string | null;
  /** 操作人名称快照：员工姓名。不给时按操作人类型取“商家”“店员”“系统”等 */
  readonly actorName?: string | null;
  /** 操作人角色快照：“交付主管”“财务”。不给时按操作人类型取“老板”“店员”“自动任务”等 */
  readonly actorRole?: string | null;
  /** 运维命令行的命令名（cli.<命令>）；只有 client 是 cli 时用，必给 */
  readonly jobName?: string | null;
  /** 周期任务的定时器行；只有系统动作用 */
  readonly timerId?: string | null;
}

/** 归属：给 storeId 必给 entityId（L0 不查门店表，不做补全）。平台级操作两个都不给 */
type AuditScope =
  | { readonly entityId?: null; readonly storeId?: null }
  | { readonly entityId: string; readonly storeId?: string | null };

/** 前后值：传整对象与字段白名单，record 只记变化的字段并脱敏。新建时 before 给 null，删除时 after 给 null */
type AuditChange =
  | { readonly before?: undefined; readonly after?: undefined; readonly fields?: undefined }
  | {
      readonly before: object | null;
      readonly after: object | null;
      readonly fields: readonly string[];
    };

export type AuditEntry = {
  /** ops 关键操作；activity 日常动作；access 查看明文与签发敏感文件读地址 */
  readonly stream: AuditStream;
  readonly category: AuditCategory;
  /** <领域>.<对象>.<动作> */
  readonly action: AuditAction;
  /** 渲染好的中文标题，写入后不再变 */
  readonly summary: string;
  /** 对象：type 是登记的表名；id 是 uuid 时进 target_id，否则进 target_key */
  readonly target?: {
    readonly type: AuditTargetType;
    readonly id: string;
    readonly label?: string | null;
  };
  /** 代操作时的被代理主体 */
  readonly onBehalfOfEntityId?: string | null;
  readonly reason?: { readonly code: string; readonly text?: string | null };
  readonly meta?: AuditMetaFields;
} & AuditScope &
  AuditChange;

export interface AuditRecorded {
  readonly id: string;
  /** 日志编号：RZ + 当日日期（北京时间）+ 序号 */
  readonly logNo: string;
}

function refuse(reason: string): never {
  throw new TypeError(`审计写入的登记值或 id 不合法：${reason}`);
}

function uuidOrNull(name: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return isUuid(value) ? value : refuse(`${name} 要是小写的 UUID`);
}

/** 操作人名称与角色的缺省快照 */
function actorSnapshot(who: Actor): { name: string; role: string } {
  if (who.type === "system") return { name: "系统", role: "自动任务" };
  if (who.type === "staff") return { name: "员工", role: "员工" };
  if (who.type === "partner") return { name: "服务商", role: "服务商" };
  if (who.role === "clerk") return { name: "店员", role: "店员" };
  return { name: "商家", role: who.role === "owner" ? "老板" : "商家" };
}

/** 规范化加清洗：算出要写的那一行。不碰库 */
export function toAuditRow(
  who: Actor,
  meta: AuditRequestMeta,
  entry: AuditEntry,
): Prisma.AuditLogUncheckedCreateInput {
  if (!AUDIT_LOG_STREAM.values.includes(entry.stream)) refuse(`流 ${String(entry.stream)}`);
  if (!isAuditCategory(entry.category)) refuse(`类别 ${String(entry.category)} 没有登记`);
  if (!isAuditAction(entry.action)) refuse("动作要写成 <领域>.<对象>.<动作>");

  // 操作人与命令行
  const system = who.type === "system";
  const cli = who.client === "cli";
  if (cli && who.type !== "staff") refuse("运维命令行只以员工身份写审计");
  const cliJob = cli ? clip(meta.jobName ?? refuse("命令行要给命令名 jobName"), 120) : "";
  const jobName = system
    ? who.job
    : cli
      ? cliJob.startsWith("cli.")
        ? cliJob
        : `cli.${cliJob}`
      : null;
  const authMethod = system ? "system" : cli ? null : meta.authMethod;
  if (authMethod !== null && !AUDIT_AUTH_METHODS.includes(authMethod)) refuse("登录方式没有登记");
  const snapshot = actorSnapshot(who);

  // 对象
  const target = entry.target;
  if (target !== undefined && !isAuditTargetType(target.type)) {
    refuse(`对象类型 ${String(target.type)} 没有登记（登记在契约的 AUDIT_TARGET_TYPES）`);
  }
  const limit = AUDIT_TEXT_LIMITS;
  const targetKey = target === undefined ? "" : clip(target.id, limit.targetKey);
  const targetId = targetKey.toLowerCase();
  const byUuid = isUuid(targetId);

  // 归属
  const entityId = uuidOrNull("entityId", entry.entityId);
  const storeId = uuidOrNull("storeId", entry.storeId);
  if (storeId !== null && entityId === null) refuse("给 storeId 必给 entityId");

  const diff = entry.fields
    ? diffFields(entry.before, entry.after, entry.fields)
    : { before: null, after: null };
  const json = (value: ReturnType<typeof capJson>): Prisma.InputJsonObject | undefined =>
    value === null ? undefined : (value as Prisma.InputJsonObject);

  return {
    id: uuidv7(),
    stream: entry.stream,
    category: entry.category,
    action: entry.action,
    summary: clip(entry.summary, limit.summary),
    actorType: who.type,
    actorId: who.id,
    client: who.client,
    // 系统动作的名称与角色固定：请求是商家或员工发的也不沿用他们的快照
    actorName: clip((system ? null : meta.actorName) ?? snapshot.name, limit.actorName),
    actorRole: clip((system ? null : meta.actorRole) ?? snapshot.role, limit.actorRole),
    onBehalfOfEntityId: uuidOrNull("onBehalfOfEntityId", entry.onBehalfOfEntityId),
    targetType: target?.type ?? null,
    targetId: target !== undefined && byUuid ? targetId : null,
    targetKey: target !== undefined && !byUuid ? targetKey : null,
    targetLabel: clipOrNull(target?.label, limit.targetLabel),
    entityId,
    storeId,
    reasonCode: clipOrNull(entry.reason?.code, limit.reasonCode),
    reasonText: clipOrNull(entry.reason?.text, limit.reasonText),
    before: json(capJson(diff.before)),
    after: json(capJson(diff.after)),
    meta: json(entry.meta == null ? null : capJson(cleanObject(entry.meta, true))),
    requestId: clipOrNull(meta.requestId, limit.requestId),
    sessionId: system || cli ? null : uuidOrNull("sessionId", meta.sessionId),
    authMethod,
    ip: system ? null : clipOrNull(meta.ip, limit.ip),
    userAgent: system ? null : clipOrNull(meta.userAgent, limit.userAgent),
    jobName,
    timerId: system ? uuidOrNull("timerId", meta.timerId) : null,
  };
}

/** 要写的列与各自的类型。created_at、log_no、seq 不在里面：由库写 */
const COLUMNS = {
  id: "uuid",
  stream: "text",
  category: "text",
  action: "text",
  summary: "text",
  actorType: "text",
  actorId: "uuid",
  client: "text",
  actorName: "text",
  actorRole: "text",
  onBehalfOfEntityId: "uuid",
  targetType: "text",
  targetId: "uuid",
  targetKey: "text",
  targetLabel: "text",
  entityId: "uuid",
  storeId: "uuid",
  reasonCode: "text",
  reasonText: "text",
  before: "jsonb",
  after: "jsonb",
  meta: "jsonb",
  requestId: "text",
  sessionId: "uuid",
  authMethod: "text",
  ip: "text",
  userAgent: "text",
  jobName: "text",
  timerId: "uuid",
} as const satisfies Partial<Record<keyof Prisma.AuditLogUncheckedCreateInput, string>>;

const FIELDS = Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>;
const INSERT = `INSERT INTO audit_log (${FIELDS.map((field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).join(", ")})
VALUES (${FIELDS.map((field, index) => `$${index + 1}::${COLUMNS[field]}`).join(", ")})
RETURNING id::text AS id, log_no AS "logNo"`;

/**
 * 写一条审计。与业务写在同一个事务里调：
 *   await tx.run(async (handle) => { …改业务行…; await audit.record(handle, actor, meta, { … }); });
 * 用一条手写的 INSERT，jsonb 三列以文本传进去：不经 Prisma 对 Json 入参的加工。它认 $type、__proto__、
 * constructor 这些键名，内容里碰上会抛错或被改写，而这里的内容来自任意的业务对象。
 */
export async function record(
  tx: Tx,
  who: Actor,
  meta: AuditRequestMeta,
  entry: AuditEntry,
): Promise<AuditRecorded> {
  const row = toAuditRow(who, meta, entry);
  const values = FIELDS.map((field) => {
    const value = row[field] ?? null;
    return COLUMNS[field] === "jsonb" && value !== null ? JSON.stringify(value) : value;
  });
  const [created] = await tx.$queryRawUnsafe<AuditRecorded[]>(INSERT, ...values);
  if (created === undefined) throw new Error("audit_log 的插入没有返回行");
  return created;
}
