import { z } from "zod";
import { AppError, assertNotInTransaction, uuidv7 } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import type { NotificationProviderResult } from "../providers/types.js";
import { sendVerdict } from "./policy.js";
import { smsDayUsage } from "./sms-budget.js";

const Input = z.strictObject({
  purpose: z.enum([
    "verify_code",
    "staff_activation",
    "account_notice",
    "ops_alert",
    "keepalive",
    "test",
  ]),
  templateKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(32),
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  params: z.record(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .max(32),
    z.string().max(200),
  ),
  directKey: z.string().min(1).max(120).optional(),
});
export type DirectNotificationInput = z.infer<typeof Input>;

/** Sensitive params live only in this call, never in a notification, delivery, log or audit. */
export function directSender(deps: NotifyDispatchDeps) {
  let closed = false;
  const calls = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  const pending = new Set<Promise<{ deliveryId: string; status: string }>>();
  async function sendDirect(raw: DirectNotificationInput) {
    assertNotInTransaction("notify.sendDirect");
    const job = execute(raw).finally(() => pending.delete(job));
    pending.add(job);
    return job;
  }
  async function execute(raw: DirectNotificationInput) {
    const input = Input.parse(raw);
    if (closed) throw new AppError("INTERNAL", { message: "通知发送已关闭" });
    if (input.purpose === "staff_activation" && !/^[A-Za-z0-9]{8}$/.test(input.params.code ?? ""))
      throw new TypeError("员工激活码必须保留正式八字符协议");
    if (input.purpose === "verify_code" && !/^\d{6}$/.test(input.params.code ?? ""))
      throw new TypeError("验证码必须为六位数字");
    const target = deps.directTarget(input.phone);
    // Params may use the caller's global pool. Read before claiming a connection (max=1 too).
    const dailyCap =
      input.purpose === "verify_code" || input.purpose === "staff_activation"
        ? null
        : await deps.params.get("notify.sms.daily_cap");
    const claimed = await deps.tx.run(async (tx) => {
      // The existing global verify anchor serializes budgets across templates and recipients.
      const keys = [...new Set(["verify_code", input.templateKey])].sort();
      for (const key of keys)
        await tx.$queryRaw`SELECT template_key FROM sms_template WHERE template_key = ${key} FOR UPDATE`;
      if (input.directKey) {
        const prior = await tx.notificationDelivery.findUnique({
          where: { directKey: input.directKey },
        });
        if (prior) return { row: prior, fresh: false };
      }
      const now = deps.clock.now(),
        template = await tx.smsTemplate.findUnique({ where: { templateKey: input.templateKey } });
      if (!template) throw new AppError("NOT_FOUND");
      const anchor = await tx.smsTemplate.findUnique({
        where: { templateKey: "verify_code" },
        select: { templateKey: true },
      });
      const configured =
        target !== null &&
        anchor !== null &&
        !!template.providerTemplateId &&
        !!template.signName &&
        ["active", "suspect"].includes(template.status) &&
        deps.providers.sms.configured &&
        (await deps.smsEnabled(tx, null));
      if (configured && target) {
        if (input.purpose === "verify_code" || input.purpose === "staff_activation") {
          for (const [ms, limit] of [
            [60_000, 1],
            [3_600_000, 5],
            [86_400_000, 10],
          ] as const) {
            if (
              (await tx.notificationDelivery.count({
                where: {
                  channel: "sms",
                  targetRef: target.phoneRef,
                  callStartedAt: { gt: new Date(now.getTime() - ms) },
                  purpose: { in: ["verify_code", "staff_activation"] },
                },
              })) >= limit
            )
              throw new AppError("RATE_LIMITED");
          }
        } else {
          if ((await smsDayUsage(tx, { targetRef: target.phoneRef, now })) >= dailyCap!)
            throw new AppError("RATE_LIMITED");
        }
      }
      const row = await tx.notificationDelivery.create({
        data: {
          id: uuidv7(),
          isDirect: true,
          channel: "sms",
          origin: "direct",
          notificationId: null,
          purpose: input.purpose,
          directKey: input.directKey ?? null,
          smsTemplateKey: input.templateKey,
          status: configured ? "sending" : "skipped",
          reason: configured ? null : "unconfigured",
          maxAttempts: 1,
          attemptNo: configured ? 1 : 0,
          dueAt: now,
          callStartedAt: configured ? now : null,
          leaseUntil: configured ? new Date(now.getTime() + 30_000) : null,
          finishedAt: configured ? null : now,
          targetRef: target?.phoneRef ?? null,
          targetMasked: target?.phoneMask ?? null,
          providerTemplateId: configured ? template.providerTemplateId : null,
          createdAt: now,
          updatedAt: now,
        },
      });
      return { row, fresh: true };
    });
    if (!claimed.fresh || claimed.row.status !== "sending")
      return { deliveryId: claimed.row.id, status: claimed.row.status };
    const controller = new AbortController();
    if (closed) controller.abort();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const call = { controller, done: Promise.resolve<unknown>(undefined) };
    call.done = (async () => {
      let result: NotificationProviderResult<unknown>;
      if (closed) {
        result = {
          ok: false,
          reason: "unavailable",
          message: "直发在外呼前已取消",
          notification: { acceptance: "not_accepted", code: "aborted" },
        };
      } else {
        try {
          result =
            input.purpose === "staff_activation"
              ? await deps.providers.sms.sendActivationCode({
                  phone: input.phone,
                  code: input.params.code!,
                  signal: controller.signal,
                })
              : await deps.providers.sms.sendSubscribeFallback({
                  phone: input.phone,
                  templateKey: input.templateKey,
                  params: input.params,
                  signal: controller.signal,
                });
        } catch {
          result = { ok: false, reason: "unavailable", message: "直发结果未知" };
        }
      }
      const verdict = sendVerdict(result),
        now = deps.clock.now();
      await deps.tx.run(async (tx) => {
        for (const key of [...new Set(["verify_code", input.templateKey])].sort())
          await tx.$queryRaw`SELECT template_key FROM sms_template WHERE template_key = ${key} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM notification_delivery WHERE id = ${claimed.row.id}::uuid FOR UPDATE`;
        await tx.notificationDelivery.updateMany({
          where: {
            id: claimed.row.id,
            attemptNo: 1,
            OR: [
              { status: "sending" },
              ...(verdict.success ? [{ status: "failed", reason: "unknown_outcome" }] : []),
            ],
          },
          data: {
            status: verdict.success ? "sent" : "failed",
            reason: verdict.success ? null : verdict.reason,
            errorCode: verdict.code,
            providerMsgId: verdict.providerMsgId,
            sentAt: verdict.success ? now : null,
            finishedAt: now,
            leaseUntil: null,
            updatedAt: now,
          },
        });
        if (verdict.success)
          await tx.smsTemplate.update({
            where: { templateKey: input.templateKey },
            data: { lastOkAt: now, updatedAt: now },
          });
      });
    })().finally(() => {
      clearTimeout(timer);
      calls.delete(call);
    });
    calls.add(call);
    await call.done;
    const row = await deps.tx.run((tx) =>
      tx.notificationDelivery.findUniqueOrThrow({ where: { id: claimed.row.id } }),
    );
    return { deliveryId: row.id, status: row.status };
  }
  return {
    sendDirect,
    async close() {
      closed = true;
      for (const call of calls) call.controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
