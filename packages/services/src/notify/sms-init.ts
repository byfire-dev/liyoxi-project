// W222 私有配置初始化；审批事实由业主提供，本函数不声称替代平台审核。
import type { PrismaClient } from "@liyoxi/db";
import { z } from "zod";
import { record } from "../audit/index.js";
import { AppError, isUuid } from "../kernel/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import { SMS_TEMPLATE_PARAMS } from "../providers/types.js";
import type { SmsTemplateBinding } from "../providers/types.js";

const KEEPALIVE_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  verify_code: { code: "123456" },
  review_result: { result: "审核通过", reason: "资料齐全" },
  sample_pending: { item: "样片" },
  launch_remind: { date: "2026-10-08", channel: "抖音", drama: "测试短剧" },
  plan_expiring: { plan: "测试套餐", expiry_date: "2026-10-09", points: "100" },
  offline_remind: { drama: "测试短剧", offline_date: "2026-10-09" },
  generic_todo: { item: "样片确认" },
  account_notice: {},
  ops_alert: { rule_name: "短信保活" },
};
/** 测试值仅用于明确的内部保活；固定定义共用 Provider 窄契约，不复制业务上限。 */
export const SMS_FIELDS = Object.fromEntries(
  Object.entries(SMS_TEMPLATE_PARAMS).map(([key, fields]) => [
    key,
    fields.map((field) => ({ ...field, test: KEEPALIVE_VALUES[key]?.[field.name] ?? "" })),
  ]),
);
export { SMS_TODO_ITEMS } from "../providers/types.js";
const TemplateSchema = z
  .object({
    templateKey: z.string(),
    kind: z.enum(["verify", "notice"]),
    providerTemplateId: z.string().regex(/^\d{1,64}$/),
    signName: z.string().regex(/^[\p{Script=Han}A-Za-z0-9]{2,12}$/u),
    params: z
      .array(z.object({ name: z.string(), maxLen: z.number().int().min(1).max(128) }).strict())
      .max(8),
    status: z.enum(["active", "pending_carrier"]),
    approval: z
      .object({
        templateApproved: z.literal(true),
        signApproved: z.literal(true),
        reference: z.string().min(1).max(120),
      })
      .strict(),
  })
  .strict();
export const SmsInitSchema = z
  .object({ templates: z.array(TemplateSchema).length(9) })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.templates.map((t) => t.templateKey)).size !== 9)
      ctx.addIssue({ code: "custom", message: "模板键重复" });
    for (const row of input.templates) {
      const fields = Object.hasOwn(SMS_FIELDS, row.templateKey)
        ? SMS_FIELDS[row.templateKey]
        : undefined;
      if (
        !fields ||
        row.kind !== (row.templateKey === "verify_code" ? "verify" : "notice") ||
        fields.length !== row.params.length ||
        fields.some(
          (field, i) =>
            field.name !== row.params[i]?.name ||
            (row.params[i]?.maxLen ?? Infinity) > field.maxLen,
        )
      )
        ctx.addIssue({ code: "custom", message: "固定模板、变量顺序或上限不符" });
    }
  });
export function createSmsInit(deps: { tx: TxRunner; clock: Clock }) {
  return async (input: { staffId: string; config: unknown }): Promise<{ changed: number }> => {
    const parsed = SmsInitSchema.safeParse(input.config);
    if (!isUuid(input.staffId) || !parsed.success)
      throw new AppError("VALIDATION_FAILED", { message: "短信模板配置不合固定清单或审批事实" });
    return deps.tx.run(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('lyx:notify:sms_init'))");
      const staff = await tx.staff.findUnique({
        where: { id: input.staffId },
        select: { status: true, staffRoleKey: true },
      });
      if (staff?.status !== "active" || staff.staffRoleKey !== "super_admin")
        throw new AppError("PERMISSION_DENIED", { message: "短信初始化须为启用的超级管理员" });
      let changed = 0;
      for (const row of [...parsed.data.templates].sort((a, b) =>
        a.templateKey.localeCompare(b.templateKey),
      )) {
        const previous = await tx.smsTemplate.findUnique({
          where: { templateKey: row.templateKey },
        });
        if (!previous || previous.kind !== row.kind)
          throw new AppError("STATE_NOT_ALLOWED", { message: "九个短信模板须先按既有种子初始化" });
        const next = {
          providerTemplateId: row.providerTemplateId,
          signName: row.signName,
          params: row.params,
          status: row.status,
        };
        if (
          previous.providerTemplateId === next.providerTemplateId &&
          previous.signName === next.signName &&
          previous.status === next.status &&
          JSON.stringify(previous.params) === JSON.stringify(next.params)
        )
          continue;
        await tx.smsTemplate.update({
          where: { templateKey: row.templateKey },
          data: { ...next, updatedAt: deps.clock.now(), lastOkAt: null },
        });
        await record(
          tx,
          { type: "staff", id: input.staffId, role: null, client: "cli" },
          {
            requestId: null,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
            jobName: "cli.sms-init",
          },
          {
            stream: "ops",
            category: "notify_config",
            action: "notify.sms.init",
            summary: "初始化短信模板配置",
            target: { type: "sms_template", id: row.templateKey },
            before: { status: previous.status, providerTemplateId: previous.providerTemplateId },
            after: { status: row.status, providerTemplateId: row.providerTemplateId },
            fields: ["status", "providerTemplateId"],
            meta: {
              paramsCount: row.params.length,
              signatureChanged: previous.signName !== row.signName,
              approvalProvided: true,
            },
          },
        );
        changed++;
      }
      return { changed };
    });
  };
}
export function smsTemplateReader(db: Pick<PrismaClient, "smsTemplate">) {
  return async (key: string): Promise<SmsTemplateBinding | null> => {
    if (!Object.hasOwn(SMS_TEMPLATE_PARAMS, key)) return null;
    const row = await db.smsTemplate.findUnique({ where: { templateKey: key } });
    if (!row || (row.kind !== "verify" && row.kind !== "notice")) return null;
    const fields = z
      .array(z.object({ name: z.string(), maxLen: z.number().int().min(1).max(128) }).strict())
      .safeParse(row.params);
    const expected = Object.hasOwn(SMS_FIELDS, key) ? SMS_FIELDS[key] : undefined;
    if (
      !fields.success ||
      !expected ||
      expected.length !== fields.data.length ||
      expected.some(
        (field, i) =>
          field.name !== fields.data[i]?.name ||
          (fields.data[i]?.maxLen ?? Infinity) > field.maxLen,
      )
    )
      return null;
    return {
      templateKey: row.templateKey,
      kind: row.kind,
      status: row.status,
      providerTemplateId: row.providerTemplateId,
      signName: row.signName,
      params: fields.data,
    };
  };
}
