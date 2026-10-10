import { describe, expect, it } from "vitest";
import {
  AdCancelCoreSubmitBodySchema as AdSubmit,
  CancelApproveBodySchema,
  CancelExecuteBodySchema,
  CancelRejectBodySchema,
  CancelVoidBodySchema,
  CancelWithdrawBodySchema,
} from "./cancel.schemas.js";

const confirm = { requestNo: "TK202610100001", totalRefundPoints: 240 };
const submit = {
  reasonCode: "merchant_request",
  note: "商家申请取消广告",
  expect: { totalRefundPoints: 240 },
};
const approve = { lockVersion: 0, confirm, confirmChecks: ["stage_rule_amount_checked"] };
const execute = { confirm, confirmChecks: ["order_points_checked"] };

describe("ad_cancel 内部命令（a05 §3.11–3.15、3.62）", () => {
  it("提交支持三种人工原因，去除说明首尾空白，允许零积分终止", () => {
    for (const reasonCode of ["merchant_request", "store_closed", "platform_fault"])
      expect(AdSubmit.parse({ ...submit, reasonCode }).reasonCode).toBe(reasonCode);
    expect(AdSubmit.parse({ ...submit, note: `  ${submit.note}  ` }).note).toBe(submit.note);
    expect(AdSubmit.safeParse({ ...submit, expect: { totalRefundPoints: 0 } }).success).toBe(true);
  });

  it("提交拒绝不支持的原因、不合规说明、分数与客服引用", () => {
    const bad = [
      { ...submit, reasonCode: "qualification_final" },
      { ...submit, note: "  取消  " },
      { ...submit, note: "字".repeat(201) },
      { ...submit, expect: { totalRefundPoints: -1 } },
      { ...submit, expect: { totalRefundPoints: 0.5 } },
      { ...submit, expect: { totalRefundPoints: 240, quoteId: "client-truth" } },
      { ...submit, serviceTicketId: "01900000-0000-7000-8000-000000000001" },
    ];
    for (const body of bad) expect(AdSubmit.safeParse(body).success).toBe(false);
  });

  it("审批与执行只收各自正式核对项，只有审批携带锁版本", () => {
    expect(CancelApproveBodySchema.parse(approve)).toEqual(approve);
    expect(CancelExecuteBodySchema.parse(execute)).toEqual(execute);
    expect(CancelApproveBodySchema.safeParse({ ...approve, lockVersion: -1 }).success).toBe(false);
    expect(CancelApproveBodySchema.safeParse({ ...approve, lockVersion: 0.5 }).success).toBe(false);
    expect(CancelExecuteBodySchema.safeParse({ ...execute, lockVersion: 0 }).success).toBe(false);
    expect(
      CancelApproveBodySchema.safeParse({ ...approve, confirmChecks: execute.confirmChecks })
        .success,
    ).toBe(false);
    expect(
      CancelExecuteBodySchema.safeParse({ ...execute, confirmChecks: approve.confirmChecks })
        .success,
    ).toBe(false);
  });

  it("审批与执行必须回显完整单号和非负整数合计，至少勾选一项", () => {
    for (const [schema, body] of [
      [CancelApproveBodySchema, approve],
      [CancelExecuteBodySchema, execute],
    ] as const) {
      const bad = [
        { ...body, confirm: { totalRefundPoints: 240 } },
        { ...body, confirm: { ...confirm, requestNo: "" } },
        { ...body, confirm: { ...confirm, totalRefundPoints: -1 } },
        { ...body, confirm: { ...confirm, totalRefundPoints: 0.5 } },
        { ...body, confirm: { ...confirm, trusted: true } },
        { ...body, confirmChecks: [] },
        { ...body, confirmChecks: ["unknown_check"] },
        { ...body, isDecidedBySystem: true },
      ];
      for (const input of bad) expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it("驳回要求说明并只允许至多一个字典编码，启用判定留给服务", () => {
    expect(CancelRejectBodySchema.parse({ note: "  说明不充分  " }).note).toBe("说明不充分");
    expect(CancelRejectBodySchema.safeParse({ note: "核算有误", reasonCodes: [] }).success).toBe(
      true,
    );
    expect(
      CancelRejectBodySchema.safeParse({ note: "核算有误", reasonCodes: ["amount_error"] }).success,
    ).toBe(true);
    for (const input of [
      {},
      { note: " " },
      { note: "字".repeat(201) },
      { note: "核算有误", reasonCodes: [" "] },
      { note: "核算有误", reasonCodes: ["a", "b"] },
      { note: "核算有误", lockVersion: 0 },
    ])
      expect(CancelRejectBodySchema.safeParse(input).success).toBe(false);
  });

  it("撤回说明按 §3.13 可选且限200字，作废说明仍必填", () => {
    expect(CancelWithdrawBodySchema.parse({})).toEqual({});
    expect(CancelWithdrawBodySchema.parse({ note: "  " })).toEqual({ note: "" });
    expect(CancelWithdrawBodySchema.safeParse({ note: "字".repeat(200) }).success).toBe(true);
    expect(CancelWithdrawBodySchema.safeParse({ note: "字".repeat(201) }).success).toBe(false);
    expect(CancelWithdrawBodySchema.safeParse({ isDecidedBySystem: true }).success).toBe(false);
    expect(CancelVoidBodySchema.parse({ note: "  不再取消  " })).toEqual({ note: "不再取消" });
    for (const body of [
      {},
      { note: " " },
      { note: "字".repeat(201) },
      { note: "不再取消", confirm },
    ])
      expect(CancelVoidBodySchema.safeParse(body).success).toBe(false);
  });
});
