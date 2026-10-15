// W4-04：四项比对只给人工提示，绝不调用入账/履约或保存识别原值。
import { z } from "zod";
import { InstantSchema } from "@liyoxi/contract";
const result = z.enum(["pass", "warn", "fail", "unknown"]);
export const TransferCheckResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        key: z.enum(["payer_name", "amount", "remark_order_no", "trade_time"]),
        result,
      }),
    )
    .length(4),
  ocrStatus: z.enum(["pending", "ok", "unavailable", "unreadable"]),
  checkedAt: InstantSchema,
});
export interface ReceiptCheckSource {
  status: "pending" | "ok" | "unavailable" | "unreadable";
  recognized: {
    payerName: string | null;
    amountFen: number | null;
    remark: string | null;
    tradedAt: string | null;
  } | null;
}
export function compareTransferReceipt(
  order: { entityName: string | null; amountFen: number; orderNo: string; createdAt: Date },
  receipt: ReceiptCheckSource,
  now: Date,
) {
  const recognized = receipt.status === "ok" ? receipt.recognized : null;
  const normalized = (text: string) => text.normalize("NFKC").replace(/\s/gu, "");
  const tradeAt = recognized?.tradedAt ? new Date(recognized.tradedAt).getTime() : NaN;
  return TransferCheckResultSchema.parse({
    items: [
      {
        key: "payer_name",
        result:
          !recognized?.payerName || !order.entityName
            ? "unknown"
            : normalized(recognized.payerName) === normalized(order.entityName)
              ? "pass"
              : "fail",
      },
      {
        key: "amount",
        result:
          recognized?.amountFen == null
            ? "unknown"
            : recognized.amountFen === order.amountFen
              ? "pass"
              : "fail",
      },
      {
        key: "remark_order_no",
        result:
          recognized?.remark == null
            ? "unknown"
            : recognized.remark.includes(order.orderNo)
              ? "pass"
              : "warn",
      },
      {
        key: "trade_time",
        result: !Number.isFinite(tradeAt)
          ? "unknown"
          : tradeAt > order.createdAt.getTime()
            ? "pass"
            : "warn",
      },
    ],
    ocrStatus: receipt.status,
    checkedAt: now.toISOString(),
  });
}
