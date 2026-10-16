// W4-04：四项比对只给人工提示，绝不调用入账/履约或保存识别原值。
import { z } from "zod";
import { EVENT_PAYLOAD_SCHEMAS, InstantSchema } from "@liyoxi/contract";
const result = z.enum(["pass", "warn", "fail", "unknown"]);
export const TransferCheckResultSchema = z
  .strictObject({
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
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.key)).size === 4,
    "四项比对键必须完整且不重复",
  );
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

import { lockRows } from "../../kernel/index.js";
import type { Tx, DeliveredEvent } from "../../kernel/index.js";
import type { TransferProof } from "@liyoxi/db";
import type { BankReceiptOcrRead } from "../../media/index.js";
import type { BillingPurchaseDeps } from "./purchase-context.js";
export async function receiptForProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  proof: TransferProof,
  mediaJobId?: string,
): Promise<BankReceiptOcrRead> {
  if (proof.ocrResultId === null || !deps.media.readBankReceiptOcr)
    return { status: "unavailable", recognized: null, warnings: [] };
  return (
    (await deps.media.readBankReceiptOcr(tx, {
      ocrResultId: proof.ocrResultId,
      fileId: proof.fileId,
      entityId: proof.entityId,
      ...(mediaJobId === undefined ? {} : { mediaJobId }),
    })) ?? { status: "unavailable", recognized: null, warnings: [] }
  );
}
export async function refreshTransferChecks(
  tx: Tx,
  deps: BillingPurchaseDeps,
  proof: TransferProof,
  receipt: BankReceiptOcrRead,
) {
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
  const entity = await tx.entity.findUniqueOrThrow({
    where: { id: proof.entityId },
    select: { name: true },
  });
  const computed = compareTransferReceipt(
    {
      entityName: entity.name,
      amountFen: order.amountFen,
      orderNo: order.orderNo,
      createdAt: order.createdAt,
    },
    receipt,
    deps.clock.now(),
  );
  const previous = TransferCheckResultSchema.safeParse(proof.checkResult);
  if (
    previous.success &&
    previous.data.ocrStatus === computed.ocrStatus &&
    JSON.stringify(previous.data.items) === JSON.stringify(computed.items)
  )
    return;
  await tx.transferProof.update({
    where: { id: proof.id },
    data: { checkResult: computed, updatedAt: deps.clock.now() },
  });
}
export async function onTransferOcrCompleted(
  tx: Tx,
  deps: BillingPurchaseDeps,
  event: DeliveredEvent,
) {
  if (event.type !== "media.ocr.completed") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["media.ocr.completed"].parse(event.payload);
  if (!deps.media.readBankReceiptOcr) throw new TypeError("回单OCR完成读口未装配");
  const receipt = await deps.media.readBankReceiptOcr(tx, {
    ocrResultId: payload.ocrResultId,
    fileId: payload.fileId,
    entityId: payload.entityId,
    mediaJobId: payload.mediaJobId,
  });
  if (!receipt || receipt.status !== payload.status) return;
  const candidates = await tx.transferProof.findMany({
    where: {
      ocrResultId: payload.ocrResultId,
      fileId: payload.fileId,
      entityId: payload.entityId,
      reviewStatus: "pending",
    },
    select: { id: true, billingOrderId: true },
    orderBy: { id: "asc" },
  });
  await lockRows(tx, "billing_order", [...new Set(candidates.map((p) => p.billingOrderId))]);
  await lockRows(
    tx,
    "transfer_proof",
    candidates.map((p) => p.id),
  );
  for (const candidate of candidates) {
    const proof = await tx.transferProof.findUniqueOrThrow({ where: { id: candidate.id } });
    const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
    if (
      proof.reviewStatus !== "pending" ||
      proof.ocrResultId !== payload.ocrResultId ||
      proof.fileId !== payload.fileId ||
      proof.entityId !== payload.entityId ||
      order.status !== "pending_confirmation" ||
      !["proof_submitted", "confirm_review"].includes(order.transferState ?? "")
    )
      continue;
    await refreshTransferChecks(tx, deps, proof, receipt);
  }
}
export function transferCheckViews(
  value: unknown,
  receipt: BankReceiptOcrRead,
  order: { entityName: string | null; amountFen: number; orderNo: string; createdAt: Date },
) {
  if (value === null) return [];
  const stored = TransferCheckResultSchema.parse(value),
    r = receipt.recognized;
  const fromProof = {
    payer_name: r?.payerName ?? null,
    amount: r?.amountFen == null ? null : String(r.amountFen),
    remark_order_no: r?.remark ?? null,
    trade_time: r?.tradedAt ?? null,
  };
  const fromOrder = {
    payer_name: order.entityName,
    amount: String(order.amountFen),
    remark_order_no: order.orderNo,
    trade_time: order.createdAt.toISOString(),
  };
  return stored.items.map((item) => ({
    ...item,
    proofValue: fromProof[item.key],
    orderValue: fromOrder[item.key],
  }));
}
