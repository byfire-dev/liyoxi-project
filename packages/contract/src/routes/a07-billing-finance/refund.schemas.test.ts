import { expect, it } from "vitest";
import {
  RefundApproveBodySchema,
  RefundExecuteBodySchema,
  RefundOfflineBodySchema,
} from "./refund.schemas.js";

it.each([
  { name: "approve", schema: RefundApproveBodySchema, key: "rule_amount_checked" },
  { name: "execute", schema: RefundExecuteBodySchema, key: "original_txn_checked" },
  { name: "offline", schema: RefundOfflineBodySchema, key: "offline_transfer_checked" },
])("$name按正式契约拒绝重复确认项，保留必含/长度守卫", ({ schema, key }) => {
  const body = {
    lockVersion: 0,
    confirm: { requestNo: "TK-TEST", amountFen: 100, channelTxnNo: "WX-TEST" },
    transferDate: "2026-01-05",
    bankSerialNo: "ISOLATED-REFUND",
    payeeName: "测试主体",
    payeeBank: "测试银行",
    payeeAccount: "6222000000000000",
    receiptFileId: "00000000-0000-7000-8000-000000000001",
  };
  expect(schema.safeParse({ ...body, confirmChecks: [key] }).success).toBe(true);
  for (const confirmChecks of [
    [key, key],
    [],
    ["another"],
    [key, ...Array.from({ length: 10 }, (_, n) => `check${n}`)],
  ])
    expect(schema.safeParse({ ...body, confirmChecks }).success).toBe(false);
});
