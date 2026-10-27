import { chainKey, rowKey } from "../../flow/index.js";
import type { MachineBinding } from "../../flow/index.js";

export function withReconciliationBinding(key: string, base: MachineBinding): MachineBinding {
  if (key !== chainKey("payment_exception", "status")) return base;
  return {
    ...base,
    guards: {
      ...base.guards,
      [rowKey("08:768", "payment_exception.auto_heal")]: async (tx, f) => {
        const id = (f.args as { wxBillLineId?: string } | undefined)?.wxBillLineId;
        const row = await tx.paymentException.findUnique({
          where: { id: f.subjectId },
          include: { paymentTxn: true },
        });
        const line = id
          ? await tx.wxBillLine.findUnique({ where: { id }, include: { wxBillFile: true } })
          : null;
        const receipt = row?.paymentTxn;
        return (
          !!row &&
          row.kind === "platform_only" &&
          row.status === "open" &&
          !!receipt &&
          !!line &&
          !line.isForeign &&
          line.lineKind === "payment" &&
          line.matchState === "matched" &&
          line.wxBillFile.status === "parsed" &&
          line.wxBillFile.isHashVerified &&
          line.billDate.getTime() === row.billDate.getTime() &&
          line.matchedPaymentTxnId === receipt.id &&
          receipt.status === "succeeded" &&
          receipt.outTradeNo === line.outTradeNo &&
          receipt.channelTxnNo === line.transactionId &&
          receipt.channelAmountFen === line.orderAmountFen
        );
      },
    },
  };
}
