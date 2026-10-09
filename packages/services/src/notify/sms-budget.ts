import { calendarDate, dayRange } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";
import { SMS_TEMPLATE_PARAMS } from "../providers/types.js";

/** Same existing seed row serializes every producer's phone budget; no external IO holds it. */
export async function lockSmsBudget(tx: Tx, templateKeys: readonly string[]): Promise<boolean> {
  const keys = [...new Set(["verify_code", ...templateKeys])].sort();
  let available = true;
  for (const key of keys) {
    if (!Object.hasOwn(SMS_TEMPLATE_PARAMS, key))
      throw new TypeError("短信预算只接受已登记的模板键");
    const rows = await tx.$queryRaw<{ templateKey: string }[]>`
      SELECT template_key AS "templateKey" FROM sms_template
       WHERE template_key = ${key} FOR UPDATE`;
    if (!rows.length) available = false;
  }
  return available;
}

/** Callers hold the shared budget anchor before counting and reserving/starting a call. */
export function smsDayUsage(tx: Tx, input: { targetRef: string; now: Date }): Promise<number> {
  const range = dayRange(calendarDate(input.now));
  return tx.notificationDelivery.count({
    where: {
      channel: "sms",
      targetRef: input.targetRef,
      OR: [
        // Started calls, including unknown/rejected outcomes, are never refunded by status.
        { callStartedAt: { gte: range.start, lt: range.end } },
        // The legacy keepalive has a separate claim TX: its live reservation already spends one.
        {
          purpose: "keepalive",
          directKey: { startsWith: "sms_keepalive:" },
          callStartedAt: null,
          status: "sending",
          createdAt: { gte: range.start, lt: range.end },
          leaseUntil: { gt: input.now },
        },
      ],
    },
  });
}
