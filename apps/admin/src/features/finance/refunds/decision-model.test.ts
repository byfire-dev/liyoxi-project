import { expect, it } from "vitest";
import type { AccessSnapshot } from "../../../lib/permissions";
import { approvalTarget } from "../../approval/model";
import {
  createRefundDecisionIntent,
  refundDecisionCommand,
  refundDecisions,
  type RefundDecisionFacts,
  type RefundDecisionInput,
} from "./decision-model";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002";
const access: AccessSnapshot = {
  staff: { id, name: "虚构财务", roleKey: "finance", roleName: "财务" },
  moduleLevels: { finance: "v" },
  dataScope: "own",
  isLead: false,
  actions: ["finance.refund.approve"],
  releases: {},
};
const input: RefundDecisionInput = {
  refundRequestId: other,
  source: "customer_service",
  requestNo: "TK-FICTIONAL",
  amountFen: 100,
  approval: { approvalId: id, kind: "plan_refund", lockVersion: 8 },
};
it("人工退款决定只消费实际actions/权限/creator；系统来源零动作，作废须待执行且服务端明确允许", () => {
  const facts: RefundDecisionFacts = {
    source: "customer_service",
    status: "pending_approval",
    actions: ["approve", "reject", "withdraw", "execute"],
    requester: null,
    approval: { kind: "plan_refund", actions: ["approve", "reject", "withdraw"], requester: null },
  };
  expect(refundDecisions(facts, access)).toEqual(["approve", "reject", "withdraw"]);
  expect(refundDecisions({ ...facts, source: "staging_probe" }, access)).toEqual([]);
  expect(
    refundDecisions(
      { ...facts, approval: { ...facts.approval, kind: "staging_pay_refund" } },
      access,
    ),
  ).toEqual([]);
  expect(refundDecisions(facts, { ...access, actions: [] })).toEqual(["withdraw"]);
  const requester = {
    staffId: id,
    staffNo: 1001,
    name: "虚构发起人",
    roleKey: "finance" as const,
    status: "active" as const,
    isLead: false,
  };
  expect(
    refundDecisions({ ...facts, requester, approval: { ...facts.approval, requester } }, access),
  ).toEqual(["withdraw"]);
  expect(
    refundDecisions(
      { ...facts, status: "pending_execution", actions: ["void", "execute"] },
      access,
    ),
  ).toEqual(["void"]);
  expect(refundDecisions({ ...facts, status: "executing", actions: ["void"] }, access)).toEqual([]);
  expect(refundDecisionCommand(input, "approve", "")).toEqual({
    action: "approve",
    body: {
      lockVersion: 8,
      confirm: { requestNo: "TK-FICTIONAL", amountFen: 100 },
      confirmChecks: ["rule_amount_checked"],
    },
  });
  expect(() => refundDecisionCommand(input, "void", " ")).toThrow();
  expect(() => refundDecisionCommand(input, "reject", " ")).toThrow();
  expect(refundDecisionCommand(input, "withdraw", "").body).toEqual({});
  const link = {
    approvalId: id,
    kind: "plan_refund",
    domain: { type: "refund_request", id: other },
    operations: { get: "admin.refundRequest.get", approve: null, reject: null, withdraw: null },
  };
  expect(approvalTarget(link, access)).toBe(`/finance/refunds?refundRequestId=${other}`);
  expect(
    approvalTarget({ ...link, domain: { type: "payment_txn", id: other } }, access),
  ).toBeNull();
  expect(
    approvalTarget(
      { ...link, operations: { ...link.operations, get: "admin.paymentOrder.get" } },
      access,
    ),
  ).toBeNull();
});
it("同步闩挡双击；未知写结果同正文原key，scope关闭取消并丢弃迟到结果", async () => {
  let sequence = 0,
    finish!: (result: string) => void,
    signal: AbortSignal | undefined;
  const intent = createRefundDecisionIntent(() => `refund:${++sequence}`),
    command = refundDecisionCommand(input, "approve", ""),
    keys: string[] = [];
  const old = intent.submit(command, (key, own) => {
    keys.push(key);
    signal = own;
    return new Promise<string>((done) => {
      finish = done;
    });
  });
  expect(await intent.submit(command, async () => "duplicate")).toBeUndefined();
  intent.close();
  expect(signal?.aborted).toBe(true);
  finish("late");
  expect(await old).toBeUndefined();
  intent.activate();
  const fail = async (key: string) => {
    keys.push(key);
    throw new Error("虚构网络未知");
  };
  await expect(intent.submit(command, fail)).rejects.toThrow("网络未知");
  await expect(intent.submit(command, fail)).rejects.toThrow();
  expect(keys[2]).toBe(keys[1]);
  await expect(
    intent.submit(refundDecisionCommand(input, "approve", "新说明"), fail),
  ).rejects.toThrow();
  expect(keys[3]).not.toBe(keys[2]);
});
