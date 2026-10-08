import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { submitConfirm } from "../../../components/ConfirmAction";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { FlowOpsApi, OutboxView, TimerView, WebhookView } from "./api";
import { FlowActionDialog, actionSpec, submitFlowAction } from "./actions";
const id = "0199e187-e72a-7000-8000-000000000001",
  fireAt = "2026-10-07T02:00:00Z";
const timer = {
  timerId: id,
  kind: "ops.retention",
  fireAt,
  status: "failed",
  actions: ["reschedule", "cancel"],
} as TimerView;
const outbox = {
  outboxEventId: id,
  subscriber: "notify.onBizEvent",
  status: "dead",
  event: { eventType: "merchant.joined" },
  actions: ["retry"],
} as OutboxView;
const webhook = {
  webhookEventId: id,
  provider: "wechatpay",
  eventType: "TRANSACTION.SUCCESS",
  processState: "dead",
  actions: ["retry"],
} as WebhookView;
function api() {
  return {
    reschedule: vi.fn().mockResolvedValue(timer),
    cancel: vi.fn().mockResolvedValue(timer),
    retryOutbox: vi.fn().mockResolvedValue(outbox),
    retryWebhook: vi.fn().mockResolvedValue(webhook),
    timers: vi.fn(),
    outbox: vi.fn(),
    webhooks: vi.fn(),
  } satisfies FlowOpsApi;
}
describe("人工恢复普通确认边界", () => {
  it("四动作精确目标/订阅者/body；没有fireAt/lockVersion/confirm协议", async () => {
    const client = api();
    await submitFlowAction(client, { kind: "reschedule", row: timer }, " ", "key-reschedule");
    await submitFlowAction(client, { kind: "cancel", row: timer }, " 测试取消原因 ", "key-cancel");
    await submitFlowAction(
      client,
      { kind: "retry-outbox", row: outbox },
      " 仅本订阅者 ",
      "key-outbox",
    );
    await submitFlowAction(client, { kind: "retry-webhook", row: webhook }, "", "key-webhook");
    expect(client.reschedule).toHaveBeenCalledWith(id, {}, "key-reschedule");
    expect(client.cancel).toHaveBeenCalledWith(id, { reason: "测试取消原因" }, "key-cancel");
    expect(client.retryOutbox).toHaveBeenCalledWith(
      id,
      { subscriber: outbox.subscriber, note: "仅本订阅者" },
      "key-outbox",
    );
    expect(client.retryWebhook).toHaveBeenCalledWith(id, {}, "key-webhook");
  });
  it("未满足原因/备注不会外发，并保持正式Unicode字数", async () => {
    const client = api();
    await expect(
      submitFlowAction(client, { kind: "cancel", row: timer }, "太短", "key"),
    ).rejects.toThrow("5–200");
    await expect(
      submitFlowAction(client, { kind: "retry-webhook", row: webhook }, "😀".repeat(201), "key"),
    ).rejects.toThrow("200");
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.retryWebhook).not.toHaveBeenCalled();
  });
  it("ConfirmAction原public只有勾选后提交；当前确认重试同key，不把取消当POST", async () => {
    const client = api(),
      action = { kind: "reschedule" as const, row: timer },
      spec = actionSpec(action, "");
    const submit = async ({ idempotencyKey }: { idempotencyKey: string }) => {
      await submitFlowAction(client, action, "", idempotencyKey);
      return { outcome: "done" as const };
    };
    expect(await submitConfirm(spec, { checked: false, typed: "" }, "one-intent", submit)).toEqual({
      outcome: "not-ready",
    });
    expect(client.reschedule).not.toHaveBeenCalled();
    await submitConfirm(spec, { checked: true, typed: "" }, "one-intent", submit);
    await submitConfirm(spec, { checked: true, typed: "" }, "one-intent", submit);
    expect(client.reschedule.mock.calls.map((call) => call[2])).toEqual([
      "one-intent",
      "one-intent",
    ]);
  });
  it("真实回显保留到期时间与复合目标，普通确认不伪造敏感回显", () => {
    const spec = actionSpec({ kind: "reschedule", row: timer }, "测试备注");
    expect(spec.echo).toContainEqual({ label: "到期时间", value: "2026-10-07 10:00" });
    expect(spec.echo.map((field) => field.value)).not.toContain(fireAt);
    expect(spec.description).toContain("不修改到期时间");
    expect(spec.sensitive).toBeUndefined();
    expect(spec.seenValue).toBeUndefined();
    expect(actionSpec({ kind: "retry-outbox", row: outbox }, "").echo).toContainEqual({
      label: "订阅者",
      value: outbox.subscriber,
    });
    expect(actionSpec({ kind: "cancel", row: timer }, "测试取消原因").danger).toBe(true);
  });
  it("真实只读/被DTO撤回动作不渲染任何确认或输入节点", () => {
    const access: AccessSnapshot = {
      staff: { id, name: "测试财务", roleKey: "finance", roleName: "财务" },
      isLead: false,
      moduleLevels: { system: "v" },
      actions: [],
      dataScope: "all",
      releases: {},
    };
    const props = { api: api(), refresh: async () => {}, onClose() {}, onDone() {} };
    expect(
      renderToStaticMarkup(
        <FlowActionDialog {...props} action={{ kind: "cancel", row: timer }} access={access} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <FlowActionDialog
          {...props}
          action={{ kind: "cancel", row: { ...timer, actions: [] } }}
          access={{ ...access, actions: ["flow.ops.manage"] }}
        />,
      ),
    ).toBe("");
  });
});
