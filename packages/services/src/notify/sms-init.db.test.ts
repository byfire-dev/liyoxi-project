import { describe, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { assembleProviders, createTxRunner, KernelViolation, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeSms,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { SmsInitSchema, SMS_FIELDS, createSmsInit, smsTemplateReader } from "./sms-init.js";
import { createSmsHealth } from "./sms-health.js";

const db = useSeededDatabase("services");
const configInput = () => ({
  templates: Object.entries(SMS_FIELDS).map(([templateKey, fields], i) => ({
    templateKey,
    kind: templateKey === "verify_code" ? ("verify" as const) : ("notice" as const),
    providerTemplateId: String(1000 + i),
    signName: "虚构测试平台",
    params: fields.map(({ name, maxLen }) => ({ name, maxLen })),
    status: "active" as const,
    approval: {
      templateApproved: true as const,
      signApproved: true as const,
      reference: "fictional-test-approval",
    },
  })),
});
async function setup() {
  await db.reset();
  const prisma = await db.prisma();
  const clock = createClock(new Date("2026-10-08T02:20:00.000Z"));
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const staff = await make.staff({ staffRoleKey: "super_admin" });
  const init = createSmsInit({ tx, clock });
  const sms = createFakeSms({ clock });
  const alerts: unknown[] = [];
  const health = () =>
    createSmsHealth({
      db: prisma,
      tx,
      clock,
      config: createConfig({ db: prisma, clock, redis: null }),
      sms,
      alerts: {
        async raise(input) {
          alerts.push(input);
        },
      },
      keyring: () => TEST_KEYRING,
      env: "test",
    });
  const param = async (key: string, value: unknown) =>
    prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value: value as never,
        createdByStaffId: staff.id,
        effectiveAt: clock.now(),
        createdAt: clock.now(),
      },
    });
  const ctx = () => ({ scheduledFor: clock.now(), runTx: tx.run.bind(tx) });
  const prepare = async (cap = 10) => {
    await init({ staffId: staff.id, config: configInput() });
    await param("notify.test_recipients", [{ staffId: staff.id, phone: "13800138000" }]);
    await param("notify.sms.daily_cap", cap);
    clock.advance(6 * 86_400_000);
  };
  return { prisma, clock, tx, make, staff, init, sms, alerts, health, param, ctx, prepare };
}
describe("短信原子初始化、自然键审计、真实库保活（独立测试库）", () => {
  it("九模板原子初始化、精确审计对象、同值重跑幂等，不造 seed approved", async () => {
    const h = await setup();
    expect(await h.prisma.smsTemplate.count({ where: { status: "unconfigured" } })).toBe(9);
    expect(await h.init({ staffId: h.staff.id, config: configInput() })).toEqual({ changed: 9 });
    const audit = await h.prisma.auditLog.findMany({ where: { action: "notify.sms.init" } });
    expect(audit).toHaveLength(9);
    expect(
      audit.every(
        (row) =>
          row.targetType === "sms_template" &&
          row.targetId === null &&
          row.targetKey &&
          row.jobName === "cli.sms-init",
      ),
    ).toBe(true);
    expect(
      JSON.stringify(audit, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("虚构测试平台");
    expect(
      JSON.stringify(audit, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("13800138000");
    const before = await h.prisma.smsTemplate.findMany();
    expect(await h.init({ staffId: h.staff.id, config: configInput() })).toEqual({ changed: 0 });
    expect(await h.prisma.smsTemplate.findMany()).toEqual(before);
    expect(await h.prisma.auditLog.count({ where: { action: "notify.sms.init" } })).toBe(9);
  }, 60_000);
  it("未知/重复键、错误kind/顺序、超长配置、缺审批，整批无写入", async () => {
    const h = await setup();
    for (const mutate of [
      (input: ReturnType<typeof configInput>) => {
        input.templates[0]!.templateKey = "unknown";
      },
      (input: ReturnType<typeof configInput>) => {
        input.templates[1]!.templateKey = "verify_code";
      },
      (input: ReturnType<typeof configInput>) => {
        input.templates[1]!.kind = "verify";
      },
      (input: ReturnType<typeof configInput>) => {
        input.templates[1]!.params.reverse();
      },
      (input: ReturnType<typeof configInput>) => {
        input.templates[1]!.params[0]!.maxLen = 999;
      },
    ]) {
      const input = configInput();
      mutate(input);
      await expect(h.init({ staffId: h.staff.id, config: input })).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
    }
    for (const key of ["constructor", "__proto__", "toString"]) {
      const input = configInput();
      input.templates[0]!.templateKey = key;
      expect(() => SmsInitSchema.safeParse(input)).not.toThrow();
      expect(SmsInitSchema.safeParse(input).success).toBe(false);
      await expect(h.init({ staffId: h.staff.id, config: input })).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
      expect(await smsTemplateReader(h.prisma)(key)).toBeNull();
    }
    expect(
      SmsInitSchema.safeParse({
        templates: configInput().templates.map(({ approval: _approval, ...row }) => row),
      }).success,
    ).toBe(false);
    expect(await h.prisma.smsTemplate.count({ where: { status: "active" } })).toBe(0);
    expect(await h.prisma.auditLog.count({ where: { action: "notify.sms.init" } })).toBe(0);
  }, 60_000);
  it("普通或停用员工拒绝，缺种子导致回滚之前已改的模板和审计", async () => {
    const h = await setup();
    const normal = await h.make.staff();
    await expect(h.init({ staffId: normal.id, config: configInput() })).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    await h.prisma.staff.update({
      where: { id: h.staff.id },
      data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
    });
    await expect(h.init({ staffId: h.staff.id, config: configInput() })).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    await h.prisma.staff.update({
      where: { id: h.staff.id },
      data: { status: "active", disabledAt: null, disabledReason: null },
    });
    await h.prisma.smsTemplate.delete({ where: { templateKey: "verify_code" } });
    await expect(h.init({ staffId: h.staff.id, config: configInput() })).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await h.prisma.smsTemplate.count({ where: { status: "active" } })).toBe(0);
    expect(await h.prisma.auditLog.count({ where: { action: "notify.sms.init" } })).toBe(0);
  }, 60_000);
  it("并发、同日重入只发送一次/模板；真实投递约束、成功同步编号、目标HMAC及mask", async () => {
    const h = await setup();
    await h.prepare();
    const health = h.health();
    await Promise.all([health.keepalive(h.ctx()), health.keepalive(h.ctx())]);
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(8);
    expect(await health.keepalive(h.ctx())).toMatchObject({ sent: 0 });
    const rows = await h.prisma.notificationDelivery.findMany();
    expect(rows).toHaveLength(8);
    expect(
      rows.every(
        (row) =>
          row.isDirect &&
          row.notificationId === null &&
          row.origin === "direct" &&
          row.purpose === "keepalive" &&
          row.status === "sent" &&
          row.attemptNo === 1 &&
          row.maxAttempts === 1 &&
          row.callStartedAt &&
          row.sentAt &&
          row.finishedAt &&
          row.providerMsgId?.startsWith("fake-message-") &&
          /^[a-f0-9]{64}$/.test(row.targetRef ?? "") &&
          row.targetMasked === "138****8000" &&
          row.leaseUntil === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("13800138000");
    expect(await h.prisma.smsTemplate.count({ where: { lastOkAt: h.clock.now() } })).toBe(8);
  }, 60_000);
  it("手机号日cap保护；disabled/pending_carrier/verify不保活，未满间隔不发", async () => {
    const h = await setup();
    await h.prepare(2);
    await h.prisma.smsTemplate.update({
      where: { templateKey: "account_notice" },
      data: { status: "disabled" },
    });
    await h.prisma.smsTemplate.update({
      where: { templateKey: "ops_alert" },
      data: { status: "pending_carrier" },
    });
    expect(await h.health().keepalive(h.ctx())).toMatchObject({ sent: 2 });
    expect(
      h.sms.sent.every(
        (message) =>
          message.kind === "template" &&
          !["verify_code", "account_notice", "ops_alert"].includes(message.templateKey),
      ),
    ).toBe(true);
    h.clock.advance(86_400_000);
    expect(await h.health().keepalive(h.ctx())).toMatchObject({ sent: 2 });
    expect(h.sms.sent).toHaveLength(4);
  }, 60_000);
  it("真实发送失败率100%置suspect并告警，不把失败当成功或重发", async () => {
    const h = await setup();
    await h.prepare();
    await h.prisma.smsTemplate.updateMany({
      where: { templateKey: { not: "generic_todo" } },
      data: { status: "disabled" },
    });
    h.sms.failNext("sendTemplate", { reason: "rejected" });
    const health = h.health();
    expect(await health.keepalive(h.ctx())).toMatchObject({ failed: 1, suspect: 1 });
    expect(
      await h.prisma.smsTemplate.findUnique({ where: { templateKey: "generic_todo" } }),
    ).toMatchObject({ status: "suspect", lastOkAt: null });
    expect(h.alerts).toHaveLength(1);
    expect(await health.keepalive(h.ctx())).toMatchObject({ failed: 0 });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(1);
  }, 60_000);
  it("claim后中断未外呼：callStartedAt为空，回收claim_exhausted且不计suspect/不重发", async () => {
    const h = await setup();
    await h.prepare();
    await h.prisma.smsTemplate.updateMany({
      where: { templateKey: { not: "account_notice" } },
      data: { status: "disabled" },
    });
    const ctx = h.ctx();
    const run = ctx.runTx;
    ctx.runTx = async (work) => {
      const result = await run(work);
      if (await h.prisma.notificationDelivery.count({ where: { status: "sending" } }))
        throw new Error("test_process_stopped_after_claim_commit");
      return result;
    };
    const health = h.health();
    await expect(health.keepalive(ctx)).rejects.toThrow("test_process_stopped_after_claim_commit");
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
      status: "sending",
      callStartedAt: null,
    });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
    h.clock.advance(31_000);
    await health.keepalive(h.ctx());
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
      status: "failed",
      reason: "claim_exhausted",
      callStartedAt: null,
    });
    expect(
      await h.prisma.smsTemplate.findUnique({ where: { templateKey: "account_notice" } }),
    ).toMatchObject({ status: "active", lastOkAt: null });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  }, 60_000);
  it("条件start时租约已过期不调用；claim后关窗取消且无发送失败率", async () => {
    for (const closeWindow of [false, true]) {
      const h = await setup();
      await h.prepare();
      if (closeWindow) h.clock.set(new Date("2026-10-14T12:59:58.000Z"));
      await h.prisma.smsTemplate.updateMany({
        where: { templateKey: { not: "account_notice" } },
        data: { status: "disabled" },
      });
      const ctx = h.ctx();
      const run = ctx.runTx;
      let delayed = false;
      ctx.runTx = async (work) => {
        const result = await run(work);
        if (
          !delayed &&
          (await h.prisma.notificationDelivery.count({ where: { status: "sending" } }))
        ) {
          delayed = true;
          h.clock.advance(closeWindow ? 3_000 : 31_000);
        }
        return result;
      };
      const health = h.health();
      await health.keepalive(ctx);
      expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
        status: closeWindow ? "cancelled" : "sending",
        reason: closeWindow ? "guard_invalid" : null,
        callStartedAt: null,
      });
      expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
      expect(h.alerts).toHaveLength(0);
      if (!closeWindow) {
        await health.keepalive(h.ctx());
        expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
          status: "failed",
          reason: "claim_exhausted",
          callStartedAt: null,
        });
      }
      expect(
        await h.prisma.smsTemplate.findUnique({ where: { templateKey: "account_notice" } }),
      ).toMatchObject({ status: "active", lastOkAt: null });
    }
  }, 60_000);
  it("外呼后取消/租约过期的迟到结果不能覆盖，下一次回收unknown且不重发", async () => {
    const h = await setup();
    await h.prepare();
    await h.prisma.smsTemplate.updateMany({
      where: { templateKey: { not: "account_notice" } },
      data: { status: "disabled" },
    });
    const original = h.sms.sendTemplate;
    h.sms.sendTemplate = async (input) => {
      expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
        status: "sending",
        callStartedAt: h.clock.now(),
      });
      const result = await original(input);
      h.clock.advance(31_000);
      return result;
    };
    const health = h.health();
    await health.keepalive(h.ctx());
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({ status: "sending" });
    await health.keepalive(h.ctx());
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
      status: "failed",
      reason: "unknown_outcome",
    });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(1);
    expect(
      await h.prisma.smsTemplate.findUnique({ where: { templateKey: "account_notice" } }),
    ).toMatchObject({ lastOkAt: null });
  }, 60_000);
  it("缺内部号/密钥、全局开关、窗口与余额unsupported均受控不外呼", async () => {
    const h = await setup();
    expect(await h.health().keepalive(h.ctx())).toEqual({ outcome: "no_internal_target" });
    expect(await h.health().balance(h.ctx())).toEqual({
      outcome: "unsupported",
      reason: "complete_package_scope_and_threshold_unconfigured",
      queried: false,
    });
    expect(h.alerts).toEqual([
      {
        rule: "notify.sms_balance_unconfigured",
        severity: "P3",
        detail: {
          outcome: "unsupported",
          reason: "complete_package_scope_and_threshold_unconfigured",
          queried: false,
        },
      },
    ]);
    await h.prepare();
    h.clock.set(new Date("2026-10-14T14:00:00.000Z"));
    expect(await h.health().keepalive(h.ctx())).toEqual({ outcome: "outside_window" });
    await h.prisma.featureFlag.update({
      where: { key: "notify.sms.enabled" },
      data: { defaultValue: false },
    });
    expect(await h.health().keepalive(h.ctx())).toEqual({ outcome: "disabled" });
    expect(h.sms.calls).toHaveLength(0);
  }, 60_000);
  it("unknown受理优先于rejected分类；真实终态写unknown_outcome", async () => {
    const h = await setup();
    await h.prepare();
    await h.prisma.smsTemplate.updateMany({
      where: { templateKey: { not: "account_notice" } },
      data: { status: "disabled" },
    });
    const original = h.sms.sendTemplate;
    h.sms.sendTemplate = async (input) => {
      await original(input);
      return { ok: false, reason: "rejected", message: "受理结果未确定", acceptance: "unknown" };
    };
    await h.health().keepalive(h.ctx());
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
      status: "failed",
      reason: "unknown_outcome",
    });
  }, 60_000);
  it("执行跨日逐claim重算日唯一键与额度；不沿用job起始日", async () => {
    const h = await setup();
    await h.prepare(1);
    h.clock.set(new Date("2026-10-14T12:59:58.000Z"));
    const original = h.sms.sendTemplate;
    let first = true;
    h.sms.sendTemplate = async (input) => {
      const result = await original(input);
      if (first) {
        first = false;
        h.clock.advance(11 * 3_600_000 + 2_000);
      }
      return result;
    };
    await h.health().keepalive(h.ctx());
    const rows = await h.prisma.notificationDelivery.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.directKey).toContain(":2026-10-14:");
    expect(rows[1]?.directKey).toContain(":2026-10-15:");
    expect(rows[1]?.createdAt).toEqual(new Date("2026-10-15T00:00:00.000Z"));
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(2);
  }, 60_000);
  it("窗口关闭与日cap预约生效后，后续claim不再发送", async () => {
    const h = await setup();
    await h.prepare();
    h.clock.set(new Date("2026-10-14T12:59:58.000Z"));
    const original = h.sms.sendTemplate;
    h.sms.sendTemplate = async (input) => {
      const result = await original(input);
      h.clock.advance(3_000);
      return result;
    };
    expect(await h.health().keepalive(h.ctx())).toMatchObject({ sent: 1 });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(1);
    const next = await setup();
    await next.prepare();
    const nextOriginal = next.sms.sendTemplate;
    next.sms.sendTemplate = async (input) => {
      const result = await nextOriginal(input);
      await next.param("notify.sms.daily_cap", 1);
      return result;
    };
    expect(await next.health().keepalive(next.ctx())).toMatchObject({ sent: 1 });
    expect(next.sms.callsOf("sendTemplate")).toHaveLength(1);
  }, 60_000);
  it("新方法由真实组合根的TX guard保护，stg保留report策略", async () => {
    const h = await setup();
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const providers = assembleProviders({ appEnv: "test", logger });
    const read = smsTemplateReader(h.prisma);
    const template = await read("account_notice");
    expect(template).not.toBeNull();
    await expect(
      h.tx.run(() =>
        providers.sms.sendTemplate({ phone: "13800138000", template: template!, params: {} }),
      ),
    ).rejects.toBeInstanceOf(KernelViolation);
    await expect(h.tx.run(() => providers.sms.checkBalance())).rejects.toBeInstanceOf(
      KernelViolation,
    );
    const reports: unknown[] = [];
    const stgTx = createTxRunner({
      prisma: h.prisma,
      appEnv: "stg",
      report: (issue) => reports.push(issue),
    });
    const stgProviders = assembleProviders({ appEnv: "stg", logger });
    expect(
      await stgTx.run(() =>
        stgProviders.sms.sendTemplate({ phone: "13800138000", template: template!, params: {} }),
      ),
    ).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(await stgTx.run(() => stgProviders.sms.checkBalance())).toMatchObject({
      ok: false,
      reason: "unconfigured",
    });
    expect(reports).toHaveLength(2);
  }, 60_000);
});
