// W5-02：九条真实HTTP，合法订购前置不手种取消申请或审批结果。
import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  CancelQuoteSchema,
  CancelRequestDetailSchema,
  CancelRequestListSchema,
  CancelRequestSummarySchema,
} from "@liyoxi/contract";
import type { CancelRequestDetail } from "@liyoxi/contract";
import {
  createFactories,
  prepareOrderFixture,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { HANDLERS } from "../src/routes/index.js";

const testApi = useTestApi();
let api: TestApi,
  requester: SignedInStaff,
  approver: SignedInStaff,
  outsider: SignedInStaff,
  denied: SignedInStaff;
let peer = 0;
const tables = [
  "approval_request",
  "cancel_request",
  "cancel_request_line",
  "drama_order",
  "order_item",
  "delivery_ticket_pause",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];
const moneyTables = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];
const request = (path: string, who = requester, body?: unknown, key: string | null = uuidv7()) =>
  api.request(`/api/v1/admin${path}`, {
    ...(body === undefined ? {} : { method: "POST", json: body }),
    headers: {
      ...who.headers,
      ...(body === undefined || key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.52.${++peer % 250}`,
  });
async function data(r: Response) {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: unknown }).data;
}
async function error(r: Response, status: number, symbol: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error: symbol });
}
const detail = async (r: Response) => CancelRequestDetailSchema.parse(await data(r));
const approveBody = (r: CancelRequestDetail) => ({
  lockVersion: r.approval.lockVersion,
  confirm: { requestNo: r.requestNo, totalRefundPoints: r.totalRefundPoints },
  confirmChecks: ["stage_rule_amount_checked"],
});
async function fresh() {
  const prisma = await testApi.db.prisma(),
    make = createFactories({ db: prisma, clock: api.clock });
  const m = await make.merchant();
  const f = await prepareOrderFixture(prisma, api.runtime, api.clock, {
    entityId: m.entity.id,
    storeId: m.store.id,
    memberId: m.owner.id,
    merchantUserId: m.user.id,
  });
  const order = await api.runtime.order.create(f.actor, f.input);
  const quote = CancelQuoteSchema.parse(
    await data(
      await request(
        `/orders/${order.orderId}/cancel-quote`,
        requester,
        { reasonCode: "merchant_request" },
        null,
      ),
    ),
  );
  return {
    ...m,
    order,
    body: { reasonCode: "merchant_request", note: "商家申请取消本次订购", expect: quote.expect },
  };
}
async function submitted() {
  const f = await fresh();
  return {
    ...f,
    cancel: await detail(
      await request(`/orders/${f.order.orderId}/cancel-requests`, requester, f.body),
    ),
  };
}
beforeAll(async () => {
  api = await testApi.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  const prisma = await testApi.db.prisma();
  requester = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
  approver = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  outsider = await signInAsStaff(prisma, { roleKey: "finance", now: api.clock.now() });
  denied = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  api.clock.advance(1);
  await prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "refund.points.auto_approve_before_production",
      value: false,
      effectiveAt: api.clock.now(),
      createdAt: api.clock.now(),
      createdByStaffId: approver.staff.id,
      reason: "取消申请HTTP审批链验证",
    },
  });
}, 180000);

describe("取消申请九个生产接口", { timeout: 60000 }, () => {
  it("admin.order.cancelQuote / admin.order.cancelRequest.create：只读试算、校验及C50重放不重复申请", async () => {
    const f = await fresh(),
      prisma = await testApi.db.prisma(),
      before = await snapshotTables(prisma, tables);
    await data(
      await request(
        `/orders/${f.order.orderId}/cancel-quote`,
        requester,
        { reasonCode: "merchant_request" },
        null,
      ),
    );
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await error(
      await request(
        `/orders/${f.order.orderId}/cancel-quote`,
        requester,
        { reasonCode: "qualification_final" },
        null,
      ),
      400,
      "VALIDATION_FAILED",
    );
    const missingKey = await request(
      `/orders/${f.order.orderId}/cancel-requests`,
      requester,
      f.body,
      null,
    );
    expect(missingKey.status).toBe(400);
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    const key = uuidv7(),
      first = await detail(
        await request(`/orders/${f.order.orderId}/cancel-requests`, requester, f.body, key),
      );
    expect(first).toMatchObject({
      status: "pending_approval",
      requester: { staffId: requester.staff.id },
    });
    const after = await snapshotTables(prisma, tables),
      replay = await request(`/orders/${f.order.orderId}/cancel-requests`, requester, f.body, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await detail(replay)).toEqual(first);
    expect(await snapshotTables(prisma, tables)).toEqual(after);
    expect(
      await prisma.dramaOrder.findUniqueOrThrow({ where: { id: f.order.orderId } }),
    ).toMatchObject({ status: "after_sale", openCancelRequestId: first.cancelRequestId });
  });

  it("admin.cancelRequest.list / summary / get：同范围、GET零业务写与无模块403", async () => {
    const f = await submitted(),
      prisma = await testApi.db.prisma();
    await prisma.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
    api.runtime.staffAuth.roles.invalidate();
    const before = await snapshotTables(prisma, tables);
    const list = CancelRequestListSchema.parse(
      await data(await request(`/cancel-requests?storeId=${f.store.id}`)),
    );
    expect(list.items.map((r) => r.cancelRequestId)).toContain(f.cancel.cancelRequestId);
    const summary = CancelRequestSummarySchema.parse(
      await data(await request(`/cancel-requests/summary?storeId=${f.store.id}`)),
    );
    expect(summary.tabs.pending_approval).toBe(1);
    expect(
      await detail(await request(`/cancel-requests/${f.cancel.cancelRequestId}`)),
    ).toMatchObject({ cancelRequestId: f.cancel.cancelRequestId });
    const hidden = CancelRequestListSchema.parse(
      await data(await request(`/cancel-requests?storeId=${f.store.id}`, outsider)),
    );
    expect(hidden.items).toEqual([]);
    const hiddenSummary = CancelRequestSummarySchema.parse(
      await data(await request(`/cancel-requests/summary?storeId=${f.store.id}`, outsider)),
    );
    expect(hiddenSummary.tabs.pending_approval).toBe(0);
    await error(
      await request(`/cancel-requests/${f.cancel.cancelRequestId}`, outsider),
      404,
      "NOT_FOUND",
    );
    await error(await request("/cancel-requests", denied), 403, "PERMISSION_DENIED");
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  });

  it("admin.cancelRequest.approve：再验证/版本/确认守卫，通过仍未退积分", async () => {
    const f = await submitted(),
      prisma = await testApi.db.prisma(),
      path = `/cancel-requests/${f.cancel.cancelRequestId}/approve`;
    api.clock.advance(600001);
    const before = await snapshotTables(prisma, tables),
      key = uuidv7();
    await error(await request(path, approver, approveBody(f.cancel), key), 403, "STEP_UP_REQUIRED");
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await prisma.staffSession.update({
      where: { id: approver.sessionId },
      data: { stepupAt: api.clock.now() },
    });
    await error(
      await request(path, approver, {
        ...approveBody(f.cancel),
        lockVersion: f.cancel.approval.lockVersion + 1,
      }),
      409,
      "VERSION_CONFLICT",
    );
    const amounts = await snapshotTables(prisma, moneyTables);
    expect(await detail(await request(path, approver, approveBody(f.cancel), key))).toMatchObject({
      status: "pending_execution",
      execution: null,
    });
    expect(await snapshotTables(prisma, moneyTables)).toEqual(amounts);
    expect(
      await prisma.pointHold.findFirstOrThrow({
        where: { entityId: f.entity.id, refType: "order_item" },
      }),
    ).toMatchObject({ status: "held" });
  });

  it("admin.cancelRequest.reject：明确skip再验证，关闭申请只恢复业务不退积分", async () => {
    const f = await submitted(),
      prisma = await testApi.db.prisma();
    api.clock.advance(600001);
    const amounts = await snapshotTables(prisma, moneyTables);
    expect(
      await detail(
        await request(`/cancel-requests/${f.cancel.cancelRequestId}/reject`, approver, {
          note: "请核实取消原因后再提交",
        }),
      ),
    ).toMatchObject({ status: "not_executed", closeReason: "rejected" });
    expect(await snapshotTables(prisma, moneyTables)).toEqual(amounts);
    expect(
      await prisma.dramaOrder.findUniqueOrThrow({ where: { id: f.order.orderId } }),
    ).toMatchObject({ status: "pending_start", openCancelRequestId: null });
  });

  it("admin.cancelRequest.withdraw：本人撤回，原key重放不重复关闭", async () => {
    const f = await submitted(),
      prisma = await testApi.db.prisma(),
      key = uuidv7(),
      path = `/cancel-requests/${f.cancel.cancelRequestId}/withdraw`;
    const first = await detail(await request(path, requester, { note: "商家决定继续原订购" }, key));
    expect(first).toMatchObject({ status: "not_executed", closeReason: "withdrawn" });
    const before = await snapshotTables(prisma, tables);
    expect(
      await detail(await request(path, requester, { note: "商家决定继续原订购" }, key)),
    ).toEqual(first);
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  });

  it("admin.cancelRequest.void：已批未执行仅申请人作废，不产生退积分", async () => {
    const f = await submitted(),
      prisma = await testApi.db.prisma();
    await prisma.staffSession.update({
      where: { id: approver.sessionId },
      data: { stepupAt: api.clock.now() },
    });
    await detail(
      await request(
        `/cancel-requests/${f.cancel.cancelRequestId}/approve`,
        approver,
        approveBody(f.cancel),
      ),
    );
    const before = await snapshotTables(prisma, moneyTables);
    expect(
      await detail(
        await request(`/cancel-requests/${f.cancel.cancelRequestId}/void`, requester, {
          note: "协商后商家决定继续制作",
        }),
      ),
    ).toMatchObject({ status: "not_executed", closeReason: "voided" });
    expect(await snapshotTables(prisma, moneyTables)).toEqual(before);
  });

  it("取消发起与同门店服务单审批引用原子提交，跨店拒绝不留申请", async () => {
    const f = await fresh(),
      prisma = await testApi.db.prisma(),
      now = api.clock.now();
    // 客服创建用例尚属 W5-06；仅准备原有 pending 工单，不伪造本包申请或审批结果。
    const ticket = await prisma.serviceTicket.create({
      data: {
        id: uuidv7(),
        ticketNo: "KF2026010500001",
        entityId: f.entity.id,
        storeId: f.store.id,
        source: "weapp",
        submitterUserId: f.user.id,
        typeCode: "K01",
        priority: "mid",
        description: "商家申请取消订购的原始咨询",
        status: "pending",
        solutionDueAt: new Date(now.getTime() + 86400000),
        slaSnapshot: { solution: {} },
        createdAt: now,
        updatedAt: now,
      },
    });
    const foreign = await fresh(),
      before = await snapshotTables(prisma, [...tables, "service_ticket_ref"]);
    await error(
      await request(`/orders/${foreign.order.orderId}/cancel-requests`, requester, {
        ...foreign.body,
        serviceTicketId: ticket.id,
      }),
      404,
      "NOT_FOUND",
    );
    expect(await snapshotTables(prisma, [...tables, "service_ticket_ref"])).toEqual(before);
    const key = uuidv7(),
      body = { ...f.body, serviceTicketId: ticket.id };
    const created = await detail(
      await request(`/orders/${f.order.orderId}/cancel-requests`, requester, body, key),
    );
    expect(
      await prisma.serviceTicketRef.findMany({ where: { serviceTicketId: ticket.id } }),
    ).toMatchObject([{ refType: "approval_request", refId: created.approval.approvalId }]);
    expect(await prisma.serviceTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(
      ticket,
    );
    const after = await snapshotTables(prisma, [...tables, "service_ticket_ref"]);
    expect(
      await detail(
        await request(`/orders/${f.order.orderId}/cancel-requests`, requester, body, key),
      ),
    ).toEqual(created);
    expect(await snapshotTables(prisma, [...tables, "service_ticket_ref"])).toEqual(after);
  });

  it("九条operationId均登记真实handler，现金退款接口继续独立", () => {
    const ids = HANDLERS.map((h) => h.route.operationId);
    for (const id of [
      "admin.order.cancelQuote",
      "admin.order.cancelRequest.create",
      "admin.cancelRequest.list",
      "admin.cancelRequest.summary",
      "admin.cancelRequest.get",
      "admin.cancelRequest.approve",
      "admin.cancelRequest.reject",
      "admin.cancelRequest.withdraw",
      "admin.cancelRequest.void",
    ])
      expect(ids.filter((v) => v === id)).toHaveLength(1);
    expect(ids).toContain("admin.refundRequest.list");
  });
});
