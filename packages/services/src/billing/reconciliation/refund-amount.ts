import type { WxBillFile, WxBillLine } from "@liyoxi/db";
import { BillValidationError } from "./parse.js";

/** 没有完整原件派生证据即受控失败；绝不把结算额当申请全额。 */
export function refundApplication(file: WxBillFile, line: WxBillLine): number {
  const summary = file.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    throw new BillValidationError("refund_evidence", line.lineNo);
  const proof = summary.refundApplications;
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    proof.v !== 1 ||
    proof.sha1 !== file.sha1 ||
    !file.isHashVerified ||
    line.wxBillFileId !== file.id ||
    line.billDate.getTime() !== file.billDate.getTime() ||
    line.lineKind !== "refund"
  )
    throw new BillValidationError("refund_evidence", line.lineNo);
  const amounts = proof.amounts;
  const amount =
    amounts && typeof amounts === "object" && !Array.isArray(amounts)
      ? amounts[String(line.lineNo)]
      : null;
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 2_147_483_647 ||
    line.refundAmountFen === null ||
    amount < line.refundAmountFen
  )
    throw new BillValidationError("refund_evidence", line.lineNo);
  return amount;
}
