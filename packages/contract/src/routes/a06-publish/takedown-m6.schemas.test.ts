import { describe, expect, it } from "vitest";
import {
  AdminTakedownTaskListQuerySchema,
  AdminTakedownTaskSummaryQuerySchema,
  TakedownTaskBatchCheckBodySchema,
  TakedownTaskCheckBodySchema,
  TakedownTaskNoteBodySchema,
  TakedownTaskBreachNoticeBodySchema,
  TakedownEventViewSchema,
} from "./takedown-m6.schemas.js";
import {
  MerchantTakedownTaskListQuerySchema,
  TakedownTaskConfirmBodySchema,
  TakedownTaskWriteResultSchema,
} from "../m05-delivery-publish/takedown.schemas.js";
import { mTakedownTaskConfirm } from "../m05-delivery-publish/takedown-tasks.js";

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const check = {
  checklistCode: "takedown.check",
  checklistVersionNo: 1,
  results: [{ key: "removed", result: "pass" }],
  evidenceFileIds: [id(1), id(2)],
};

describe("下架契约的原子批量与两端边界", () => {
  it("确认只接收方式；不接收证据、版本或抽签参数，重放声明封面脱敏", () => {
    for (const method of ["delete", "private", "not_published"])
      expect(TakedownTaskConfirmBodySchema.parse({ method })).toEqual({ method });
    for (const extra of [{ evidenceFileIds: [] }, { lockVersion: 1 }, { sampleBp: 0 }])
      expect(TakedownTaskConfirmBodySchema.safeParse({ method: "delete", ...extra }).success).toBe(
        false,
      );
    expect(mTakedownTaskConfirm["x-redact-on-replay"]).toEqual(["posterUrl"]);
    expect(TakedownTaskWriteResultSchema.shape.posterUrl.safeParse(null).success).toBe(true);
    expect(TakedownTaskWriteResultSchema.shape.posterUrl.safeParse(undefined).success).toBe(false);
  });
  it("单条证据2–9张且唯一；空清单仍交模板服务判定", () => {
    expect(TakedownTaskCheckBodySchema.parse(check)).toEqual(check);
    expect(TakedownTaskCheckBodySchema.safeParse({ ...check, results: [] }).success).toBe(true);
    for (const evidenceFileIds of [
      [id(1)],
      Array.from({ length: 10 }, (_, n) => id(n)),
      [id(1), id(1)],
    ])
      expect(TakedownTaskCheckBodySchema.safeParse({ ...check, evidenceFileIds }).success).toBe(
        false,
      );
  });
  it("批量1–50个不同任务，不把业务失败转成部分成功结构", () => {
    const item = { ...check, takedownTaskId: id(3) };
    expect(TakedownTaskBatchCheckBodySchema.safeParse({ items: [item] }).success).toBe(true);
    expect(
      TakedownTaskBatchCheckBodySchema.safeParse({
        items: Array.from({ length: 50 }, (_, n) => ({ ...check, takedownTaskId: id(n + 3) })),
      }).success,
    ).toBe(true);
    for (const items of [
      [],
      [item, item],
      Array.from({ length: 51 }, (_, n) => ({ ...check, takedownTaskId: id(n + 3) })),
    ])
      expect(TakedownTaskBatchCheckBodySchema.safeParse({ items }).success).toBe(false);
  });
  it("查询false不被转为true，status不含void，summary保留公共筛选", () => {
    expect(AdminTakedownTaskListQuerySchema.parse({ isOverdue: "false" })).toMatchObject({
      isOverdue: false,
      tab: "pending",
      page: 1,
      pageSize: 20,
    });
    expect(AdminTakedownTaskListQuerySchema.safeParse({ status: "void" }).success).toBe(false);
    expect(
      AdminTakedownTaskSummaryQuerySchema.parse({
        storeId: id(1),
        basis: "live",
        isOverdue: "true",
        q: "test",
      }),
    ).toEqual({ storeId: id(1), basis: "live", isOverdue: true, q: "test" });
    expect(MerchantTakedownTaskListQuerySchema.parse({})).toEqual({ tab: "pending", limit: 20 });
  });
  it("说明可空但最多200字，违约提醒为空体；完整13类时间线", () => {
    expect(TakedownTaskNoteBodySchema.parse({ note: "" })).toEqual({ note: "" });
    expect(TakedownTaskNoteBodySchema.safeParse({ note: "x".repeat(201) }).success).toBe(false);
    expect(TakedownTaskBreachNoticeBodySchema.safeParse({ note: "x" }).success).toBe(false);
    expect(TakedownEventViewSchema.shape.kind.options).toEqual([
      "created",
      "auto_reminded",
      "manual_reminded",
      "merchant_confirmed",
      "sample_released",
      "found_online",
      "basis_reopened",
      "escalated",
      "breach_notified",
      "checked",
      "voided",
      "check_due_recalculated",
      "follow_up",
    ]);
  });
});
