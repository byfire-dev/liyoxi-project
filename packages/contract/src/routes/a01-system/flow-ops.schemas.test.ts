import { describe, expect, it } from "vitest";
import {
  TimerListQuerySchema,
  OutboxDeliveryListQuerySchema,
  WebhookEventListQuerySchema,
  FlowOpsNoteBodySchema,
  TimerCancelBodySchema,
  OutboxRetryBodySchema,
} from "./flow-ops.schemas.js";
import * as queries from "@liyoxi/contract/queries/admin";
import { adminTimerList, adminTimerCancel, adminTimerReschedule } from "./timers.js";
import { adminOutboxEventRetry } from "./outbox-events.js";
import { adminWebhookEventRetry } from "./webhook-events.js";
const id = "019a0000-0000-7000-8000-000000000001";
describe("W223实际协议", () => {
  it("两页码默认与收件游标默认、CSV、日期/主体联动", () => {
    expect(TimerListQuerySchema.parse({})).toEqual({ status: ["failed"], page: 1, pageSize: 20 });
    expect(OutboxDeliveryListQuerySchema.parse({})).toEqual({
      status: ["dead"],
      page: 1,
      pageSize: 20,
    });
    expect(WebhookEventListQuerySchema.parse({})).toEqual({
      processState: ["failed", "dead"],
      limit: 20,
    });
    expect(TimerListQuerySchema.parse({ status: "failed,scheduled,failed" }).status).toEqual([
      "failed",
      "scheduled",
    ]);
    for (const q of [
      { status: "other" },
      { subjectId: id },
      { fireFrom: "2026-01-02", fireTo: "2026-01-01" },
      { kind: "other" },
      { page: 0 },
      { pageSize: 101 },
    ])
      expect(TimerListQuerySchema.safeParse(q).success).toBe(false);
    expect(OutboxDeliveryListQuerySchema.safeParse({ subscriber: "attacker.fake" }).success).toBe(
      false,
    );
    expect(
      OutboxDeliveryListQuerySchema.safeParse({ aggregateType: "service_ticket" }).success,
    ).toBe(false);
    expect(WebhookEventListQuerySchema.safeParse({ receivedFrom: "2026-02-30" }).success).toBe(
      false,
    );
    expect(WebhookEventListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it("HTTP备注可选而取消理由5–200；禁止fireAt/新订阅者/额外字段", () => {
    expect(FlowOpsNoteBodySchema.parse({})).toEqual({});
    expect(FlowOpsNoteBodySchema.safeParse({ fireAt: "2026-01-01" }).success).toBe(false);
    expect(TimerCancelBodySchema.safeParse({ reason: "短" }).success).toBe(false);
    expect(TimerCancelBodySchema.safeParse({ reason: "原因至少五字" }).success).toBe(true);
    expect(FlowOpsNoteBodySchema.safeParse({ note: "🙂".repeat(200) }).success).toBe(true);
    expect(FlowOpsNoteBodySchema.safeParse({ note: "🙂".repeat(201) }).success).toBe(false);
    expect(OutboxRetryBodySchema.safeParse({ subscriber: "support.onBizEvent" }).success).toBe(
      true,
    );
    expect(OutboxRetryBodySchema.safeParse({ subscriber: "attacker" }).success).toBe(false);
  });
  it("公开查询与原权限/required/无回显元数据", () => {
    expect(queries.TimerListQuerySchema).toBe(TimerListQuerySchema);
    expect(adminTimerList["x-permission"]).toBe("assert-in-handler");
    for (const route of [
      adminTimerCancel,
      adminTimerReschedule,
      adminOutboxEventRetry,
      adminWebhookEventRetry,
    ]) {
      expect(route["x-permission"]).toBe("flow.ops.manage");
      expect(route["x-idempotent"]).toBe("required");
      expect(route["x-confirm"]).toBeUndefined();
    }
  });
});
