import type {
  RefundExecuteBody,
  RefundOfflineBody,
  RefundRetryBody,
  RefundNotAcceptedBody,
} from "@liyoxi/contract";
export type RefundExecution = "execute" | "retry" | "confirm-not-accepted" | "record-offline";
export type RefundExecutionCommand =
  | { action: "execute"; body: RefundExecuteBody }
  | { action: "retry"; body: RefundRetryBody }
  | { action: "confirm-not-accepted"; body: RefundNotAcceptedBody }
  | { action: "record-offline"; body: RefundOfflineBody };
export interface OfflineRefundDraft {
  transferDate: string;
  bankSerialNo: string;
  payeeName: string;
  payeeBank: string;
  payeeAccount: string;
  receiptFileId: string | null;
  note: string;
}
