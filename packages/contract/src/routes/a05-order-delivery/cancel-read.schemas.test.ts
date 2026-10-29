import { describe, expect, it } from "vitest";
import {
  CancelActionsSchema,
  CancelRequestFiltersSchema,
  CancelRequestListQuerySchema,
  OrderCancelRequestCreateBodySchema,
} from "./cancel.schemas.js";

const id = "019ac859-6921-7000-8000-000000000001";
describe("W5-02取消读写契约边界", () => {
  it("创建仅接受人工原因、规范说明和唯一明细；不接受执行字段或系统原因", () => {
    const body = {
      reasonCode: "merchant_request",
      note: "  商家申请取消订购  ",
      expect: { totalRefundPoints: 0 },
      orderItemIds: [id],
      serviceTicketId: id,
    };
    expect(OrderCancelRequestCreateBodySchema.parse(body).note).toBe("商家申请取消订购");
    for (const patch of [
      { reasonCode: "qualification_final" },
      { orderItemIds: [id, id] },
      { note: "太短" },
      { status: "done" },
      { expect: { totalRefundPoints: -1 } },
    ])
      expect(OrderCancelRequestCreateBodySchema.safeParse({ ...body, ...patch }).success).toBe(
        false,
      );
  });
  it("分页、CSV、布尔与日期只接受合法边界，含同一自然日", () => {
    expect(
      CancelRequestListQuerySchema.parse({
        kind: "order_cancel,qualification_cancel,order_cancel",
        overdueOnly: "false",
        submittedFrom: "2026-01-01",
        submittedTo: "2026-01-01",
      }),
    ).toMatchObject({
      kind: ["order_cancel", "qualification_cancel"],
      overdueOnly: false,
      page: 1,
      pageSize: 20,
      tab: "pending_approval",
      sort: "urgency",
    });
    for (const input of [
      { kind: "order_cancel," },
      { kind: "bogus" },
      { overdueOnly: "0" },
      { submittedFrom: "2026-02-30" },
      { submittedFrom: "2026-02-01", submittedTo: "2026-01-31" },
      { page: "0" },
      { pageSize: "101" },
      { sort: "submittedAt" },
      { requesterId: "all" },
    ])
      expect(CancelRequestListQuerySchema.safeParse(input).success).toBe(false);
  });
  it("summary不接受列表控制参数，领域动作保持五种并拒绝审核动作", () => {
    expect(CancelRequestFiltersSchema.safeParse({ tab: "all" }).success).toBe(false);
    expect(
      CancelActionsSchema.parse(["approve", "reject", "withdraw", "void", "execute"]),
    ).toHaveLength(5);
    expect(CancelActionsSchema.safeParse(["approve-review"]).success).toBe(false);
  });
});
