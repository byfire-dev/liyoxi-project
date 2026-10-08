import { createHash } from "node:crypto";
import { calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "../../kernel/index.js";
import type { AdminLiveFixture } from "./context.js";
// 本轮隔离库的合法技术失败事实；不启动真实 worker/provider 或改兄弟角色/员工。
const fixture: AdminLiveFixture = async ({ runtime }) => {
  const now = runtime.clock.now(),
    fireAt = new Date(now.getTime() - 60_000),
    subscriber = "staff.onCalendarImported";
  const timers = [],
    outbox = [],
    webhooks = [];
  for (let index = 0; index < 12; index++) {
    const timerId = uuidv7(),
      outboxEventId = uuidv7(),
      webhookEventId = uuidv7(),
      time = new Date(now.getTime() - index * 1000),
      label = String(index + 1).padStart(2, "0");
    await runtime.tx.run(async (tx) => {
      await tx.timer.create({
        data: {
          id: timerId,
          kind: "ops.retention",
          fireAt,
          dedupeKey: `w223:timer:${label}`,
          status: "failed",
          attempts: 5,
          dispatchNo: 3,
          lastError: `流程验收定时失败 ${label}`,
          result: { processed: 0 },
          createdAt: time,
          updatedAt: time,
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: outboxEventId,
          eventType: "calendar.imported",
          payload: {
            v: 1,
            calendarVersion: 9000 + index,
            year: Number(calendarDate(now).slice(0, 4)),
            changedDays: [calendarDate(now)],
          },
          actorType: "system",
          occurredAt: time,
          dedupeKey: `w223:outbox:${label}`,
          publishedAt: time,
          createdAt: time,
        },
      });
      await tx.outboxDelivery.create({
        data: {
          outboxEventId,
          subscriber,
          status: "dead",
          attempts: 5,
          dispatchNo: 3,
          nextAttemptAt: time,
          lastError: `流程验收投递失败 ${label}`,
          createdAt: time,
          updatedAt: time,
        },
      });
      await tx.webhookEvent.create({
        data: {
          id: webhookEventId,
          provider: "wechatpay",
          eventId: `w223-${label}`,
          eventType: "TRANSACTION.SUCCESS",
          mode: "inbox",
          receivedAt: time,
          payload: { summary: { serial: `A${label}`, state: "SUCCESS", amountFen: 100 } },
          payloadDigest: createHash("sha256").update(`w223-${label}`).digest(),
          processState: index === 11 ? "failed" : "dead",
          attempts: 5,
          nextAttemptAt: time,
          error: `流程验收回调失败 ${label}`,
          createdAt: time,
          updatedAt: time,
        },
      });
    });
    timers.push({ timerId, fireAt: fireAt.toISOString(), label });
    outbox.push({ outboxEventId, subscriber, label });
    webhooks.push({ webhookEventId, eventId: `w223-${label}`, label });
  }
  return { timers, outbox, webhooks };
};
export default fixture;
