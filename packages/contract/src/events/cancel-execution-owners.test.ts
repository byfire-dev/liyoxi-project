import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018f0000-0000-7000-8000-000000000001";
const cases = [
  [
    "ticket.terminated",
    {
      v: 1,
      deliveryTicketId: id,
      orderItemId: id,
      cancelRequestId: id,
      fromState: "sample_confirm",
      toState: "terminated",
      transition: "ticket.terminate",
    },
  ],
  [
    "launch.voided",
    {
      v: 1,
      launchTaskId: id,
      orderItemId: id,
      voidReason: "terminated",
      fromState: "verifying",
      toState: "void",
      transition: "launch.void",
    },
  ],
  [
    "launch.settled",
    {
      v: 1,
      launchTaskId: id,
      orderItemId: id,
      fromState: "verifying",
      toState: "passed",
      transition: "launch.settle",
    },
  ],
  [
    "patrol.voided",
    { v: 1, patrolTaskId: id, fromState: "abnormal", toState: "void", transition: "patrol.void" },
  ],
  [
    "takedown.created",
    {
      v: 1,
      takedownTaskId: id,
      orderItemId: id,
      channelAccountId: id,
      dueDate: "2026-11-01",
      basis: "live",
      triggerKind: "platform_termination",
      node: "created",
      fromState: null,
      toState: "pending_merchant",
      transition: "takedown.create",
    },
  ],
] as const;

it.each(cases)("取消owner事件 %s 保留完整冻结载荷并拒绝额外或错误迁移键", (name, body) => {
  const schema = EVENT_PAYLOAD_SCHEMAS[name];
  expect(schema.parse(body)).toEqual(body);
  for (const patch of [
    { v: 2 },
    { extra: true },
    { fromState: "invalid" },
    { toState: "invalid" },
    { transition: "admin.force" },
  ])
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
  const { fromState: _from, ...missing } = body;
  expect(schema.safeParse(missing).success).toBe(false);
});

it("上线终止只进入下架，未上线终止只进入terminated", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["ticket.terminated"],
    body = cases[0][1];
  expect(schema.safeParse({ ...body, fromState: "in_service", toState: "takedown" }).success).toBe(
    true,
  );
  expect(schema.safeParse({ ...body, fromState: "takedown", toState: "takedown" }).success).toBe(
    true,
  );
  expect(schema.safeParse({ ...body, fromState: "in_service" }).success).toBe(false);
  expect(schema.safeParse({ ...body, cancelRequestId: undefined }).success).toBe(false);
});

it("下架创建必须含真实发布账号、日期、依据、原因与通知节点", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["takedown.created"],
    body = cases[4][1];
  for (const patch of [
    { channelAccountId: "bad" },
    { dueDate: "2026-02-30" },
    { basis: "unknown" },
    { triggerKind: "unknown" },
    { node: "unknown" },
  ])
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
});
