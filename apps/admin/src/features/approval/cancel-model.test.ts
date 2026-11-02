import { ApprovalDetailSchema } from "@liyoxi/contract";
import { expect, it, vi } from "vitest";
import type { AccessSnapshot } from "../../lib/permissions";
import { cancelFixture, fixtureId } from "../order/orders/test-data.fixture";
import { CancelFailure, type CancelCommand } from "./cancel-api";
import { approvalQuery, approvalSearch, approvalTarget } from "./model";
import {
  cancelActions,
  cancelApprovalId,
  cancelCommand,
  cancelDecisionFacts,
  cancelQuery,
  cancelSummaryQuery,
  cancelTarget,
  createCancelIntent,
  matchesCancelApproval,
} from "./cancel-model";

const access: AccessSnapshot = {
  staff: { id: fixtureId(30), name: "演练财务", roleKey: "finance", roleName: "财务" },
  isLead: false,
  moduleLevels: { finance: "e", order: "e", merchant: "v", delivery: "v" },
  actions: ["finance.refund.approve", "finance.refund.execute", "order.refund.request"],
  dataScope: "all",
  releases: {},
};
const detail = () =>
  cancelFixture({
    actions: ["approve", "reject", "withdraw"],
    approval: { actions: ["approve", "reject", "withdraw"] },
  });
function approval(value = detail()) {
  return ApprovalDetailSchema.parse({
    ...value.approval,
    category: "approval",
    requestNo: value.requestNo,
    subjectType: value.target.type,
    subjectId: value.target.id,
    entityId: value.store.entityId,
    storeId: value.store.storeId,
    deliveryTicketId: null,
    summary: { title: "演练取消" },
    domain: { type: "cancel_request", id: value.cancelRequestId },
    submitter: { actorType: "system", actorId: null, label: "系统" },
    handler: null,
    checklist: null,
    confirmChecks: [],
    sla: null,
    timeline: [],
    operations: {
      get: "admin.cancelRequest.get",
      approve: "admin.cancelRequest.approve",
      reject: "admin.cancelRequest.reject",
      withdraw: "admin.cancelRequest.withdraw",
    },
  });
}
it("三种取消只接受精确kind/domain/完整operation和真实approvalId及门店主体关系，原现金路由保持独立", () => {
  for (const kind of ["order_cancel", "ad_cancel", "qualification_cancel"] as const) {
    const value = cancelFixture({ kind, approval: { kind } }),
      row = approval(value);
    expect(cancelApprovalId(row)).toBe(value.cancelRequestId);
    expect(matchesCancelApproval(row, value)).toBe(true);
    expect(matchesCancelApproval({ ...row, approvalId: fixtureId(40) }, value)).toBe(false);
    expect(matchesCancelApproval({ ...row, storeId: fixtureId(41) }, value)).toBe(false);
    expect(matchesCancelApproval({ ...row, entityId: fixtureId(42) }, value)).toBe(false);
    for (const key of ["get", "approve", "reject", "withdraw"] as const)
      expect(
        cancelApprovalId({
          ...row,
          operations: { ...row.operations, [key]: "admin.refundRequest.get" },
        }),
      ).toBeNull();
    expect(
      cancelApprovalId({ ...row, domain: { type: "refund_request", id: value.cancelRequestId } }),
    ).toBeNull();
    expect(approvalTarget(row, access)).toBeNull();
  }
});
it("list与summary使用相同业务筛选且待执行不遗漏，取消URL与原generic审批查询隔离", () => {
  const raw = {
    cancel_q: "订单",
    cancel_kind: "order_cancel,qualification_cancel",
    cancel_tab: "pending_execution",
    cancel_overdueOnly: "true",
    cancel_requesterId: "me",
    cancel_page: "2",
    cancel_pageSize: "50",
    cancel_storeId: fixtureId(3),
    id: fixtureId(10),
    cancelId: fixtureId(8),
  };
  const query = cancelQuery(raw),
    summary = cancelSummaryQuery(raw);
  expect(query).toMatchObject({
    kind: raw.cancel_kind,
    tab: "pending_execution",
    overdueOnly: "true",
    requesterId: "me",
    page: 2,
    pageSize: 50,
  });
  expect(summary).toEqual({
    q: "订单",
    kind: raw.cancel_kind,
    overdueOnly: "true",
    requesterId: "me",
    storeId: fixtureId(3),
  });
  expect(approvalSearch(raw)).toHaveProperty("cancelId", fixtureId(8));
  expect(Object.keys(approvalQuery(raw)).some((key) => key.startsWith("cancel"))).toBe(false);
  expect(
    approvalSearch({ cancelId: "outside", cancel_kind: "plan_refund", cancel_tab: "done" }),
  ).not.toHaveProperty("cancelId");
  expect(cancelQuery({ cancel_tab: "not-valid" }).tab).toBe("pending_approval");
});
it("批准只回传approval版本；执行不带CAS，积分回显与两个独立check保持契约真值", () => {
  expect(cancelCommand(detail(), "approve", "")).toEqual({
    action: "approve",
    body: {
      lockVersion: 7,
      confirm: { requestNo: "QX-FICTIONAL-001", totalRefundPoints: 100 },
      confirmChecks: ["stage_rule_amount_checked"],
    },
  });
  expect(cancelCommand(detail(), "execute", "")).toEqual({
    action: "execute",
    body: {
      confirm: { requestNo: "QX-FICTIONAL-001", totalRefundPoints: 100 },
      confirmChecks: ["order_points_checked"],
    },
  });
  expect(cancelCommand(detail(), "reject", " 原因 ")).toEqual({
    action: "reject",
    body: { note: "原因" },
  });
  expect(cancelCommand(detail(), "withdraw", " ")).toEqual({ action: "withdraw", body: {} });
  expect(() => cancelCommand(detail(), "void", " ")).toThrow();
});
it("动作遵循当前actions、权限和二人边界；系统requester null不误杀，void用order.refund.request", () => {
  expect(cancelActions(detail(), access)).toEqual(["approve", "reject", "withdraw"]);
  const requester = {
    staffId: access.staff.id,
    name: "演练发起人",
    staffNo: 1001,
    roleKey: "finance" as const,
    status: "active" as const,
    isLead: false,
  };
  expect(
    cancelActions(
      cancelFixture({
        requester,
        actions: ["approve", "reject", "withdraw"],
        approval: { requester, actions: ["approve", "reject", "withdraw"] },
      }),
      access,
    ),
  ).toEqual(["withdraw"]);
  const pending = cancelFixture({
    status: "pending_execution",
    approvalStatus: "approved",
    requester,
    actions: ["void", "execute"],
    approval: { status: "approved" },
  });
  expect(cancelActions(pending, access)).toEqual(["void", "execute"]);
  expect(cancelActions(pending, { ...access, actions: ["finance.refund.approve"] })).toEqual([]);
  expect(cancelActions({ ...pending, actions: [] }, access)).toEqual([]);
});
it("业务导航只使用真实GET目标且遵守目标页面模块权限，系统资质取消仍可导航门店", () => {
  expect(cancelTarget(detail(), access)).toBe("/orders/DD-FICTIONAL-001");
  expect(cancelTarget(detail(), { ...access, moduleLevels: { finance: "e" } })).toBeNull();
  const qualification = cancelFixture({
    kind: "qualification_cancel",
    order: null,
    approval: { kind: "qualification_cancel" },
  });
  expect(cancelTarget(qualification, access)).toBe(`/merchants/${fixtureId(3)}`);
});
it("同步闩阻止同tick双击，scope关闭后即使旧请求忽略abort也不应用结果", async () => {
  let release!: () => void;
  const intent = createCancelIntent(() => "same-key"),
    command = cancelCommand(detail(), "approve", "");
  const send = vi.fn(
      (_command: CancelCommand, _key: string, _signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
    read = vi.fn(async () => detail());
  const first = intent.submit(command, send, read, () => true);
  expect(await intent.submit(command, send, read, () => true)).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  const signal = send.mock.calls[0]?.[2];
  intent.close();
  release();
  expect(await first).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(true);
});
it("网络未知保留原正文和key，改正文被拒；同key重放后仅一次真实GET", async () => {
  const intent = createCancelIntent(() => "original-key"),
    command = cancelCommand(detail(), "reject", "原因");
  const send = vi.fn(async () => {
      throw new TypeError("network");
    }),
    read = vi.fn(async () => detail());
  await expect(intent.submit(command, send, read, () => true)).rejects.toThrow();
  await expect(
    intent.submit(cancelCommand(detail(), "reject", "另一个原因"), send, read, () => true),
  ).rejects.toMatchObject({ code: "UNRESOLVED_INTENT" });
  const retry = vi.fn(async (_command: CancelCommand, _key: string, _signal: AbortSignal) => {});
  expect(await intent.submit(command, retry, read, () => true)).toEqual(detail());
  expect(retry.mock.calls[0]?.slice(0, 2)).toEqual([command, "original-key"]);
  expect(read).toHaveBeenCalledTimes(3);
});
it("POST已受理而GET失败后只准GET恢复，绝不再POST；409明确拒绝允许刷新后换新意图", async () => {
  let n = 0;
  const intent = createCancelIntent(() => `key-${++n}`),
    command = cancelCommand(detail(), "approve", ""),
    send = vi.fn(async () => {});
  let reads = 0;
  await expect(
    intent.submit(
      command,
      send,
      async () => {
        if (++reads === 1) return detail();
        throw new TypeError("read failed");
      },
      () => true,
    ),
  ).rejects.toThrow();
  expect(intent.accepted).toBe(true);
  expect(
    await intent.submit(
      command,
      send,
      async () => detail(),
      () => true,
    ),
  ).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  expect(await intent.refresh(async () => detail())).toEqual(detail());
  expect(intent.accepted).toBe(false);
  await expect(
    intent.submit(
      command,
      async () => {
        throw new CancelFailure("PRECONDITION_CHANGED", 409);
      },
      async () => detail(),
      () => true,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(intent.unresolved).toBe(false);
  const next = vi.fn(async (_command: CancelCommand, _key: string, _signal: AbortSignal) => {});
  await intent.submit(
    cancelCommand(detail(), "reject", "重核原因"),
    next,
    async () => detail(),
    () => true,
  );
  expect(next.mock.calls[0]?.[1]).toBe("key-3");
});
it("确认后每个无CAS动作都真实GET重核；服务端actions/状态变化先停写，GET迟到也零POST", async () => {
  for (const action of ["reject", "withdraw", "void", "execute"] as const) {
    const initial = cancelFixture({
      status: action === "void" || action === "execute" ? "pending_execution" : "pending_approval",
      actions: [action],
      approval: { actions: [action] },
    });
    const current = { ...initial, actions: [] },
      intent = createCancelIntent(),
      send = vi.fn(async () => {});
    const read = vi.fn(async () => current);
    await expect(
      intent.submit(
        cancelCommand(initial, action, "核对说明"),
        send,
        read,
        (fresh) => cancelDecisionFacts(fresh) === cancelDecisionFacts(initial),
      ),
    ).rejects.toMatchObject({ message: "PRECONDITION_CHANGED", detail: current });
    expect(read).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(intent.unresolved).toBe(false);
  }
  let complete!: (value: ReturnType<typeof detail>) => void;
  const intent = createCancelIntent(),
    send = vi.fn(async () => {}),
    read = () =>
      new Promise<ReturnType<typeof detail>>((resolve) => {
        complete = resolve;
      });
  const pending = intent.submit(cancelCommand(detail(), "approve", ""), send, read, () => true);
  intent.close();
  complete(detail());
  expect(await pending).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});
it.each([
  [502, "PROVIDER_UNAVAILABLE"],
  [504, "UPSTREAM_TIMEOUT"],
  [409, "IDEMPOTENCY_IN_PROGRESS"],
] as const)("%s/%s保持未知原key；重放前GET变化保原意图且零追加POST", async (status, code) => {
  const intent = createCancelIntent(() => "same-unknown-key"),
    command = cancelCommand(detail(), "reject", "核对说明"),
    send = vi.fn(async (_command: CancelCommand, _key: string, _signal: AbortSignal) => {
      throw new CancelFailure(code, status);
    });
  await expect(
    intent.submit(
      command,
      send,
      async () => detail(),
      () => true,
    ),
  ).rejects.toMatchObject({ status });
  expect(intent.unresolved).toBe(true);
  await expect(
    intent.submit(
      command,
      send,
      async () => {
        throw new CancelFailure("PERMISSION_DENIED", 403);
      },
      () => true,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(intent.command).toEqual(command);
  expect(intent.unresolved).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  const changed = cancelFixture({ status: "not_executed", actions: [] });
  await expect(
    intent.submit(
      command,
      send,
      async () => changed,
      (fresh) => cancelDecisionFacts(fresh) === cancelDecisionFacts(detail()),
    ),
  ).rejects.toMatchObject({ message: "PRECONDITION_CHANGED" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(intent.command).toEqual(command);
  expect(intent.unresolved).toBe(true);
  const retry = vi.fn(async (_command: CancelCommand, _key: string, _signal: AbortSignal) => {});
  await intent.submit(
    command,
    retry,
    async () => detail(),
    () => true,
  );
  expect(retry.mock.calls[0]?.slice(0, 2)).toEqual([command, "same-unknown-key"]);
});
