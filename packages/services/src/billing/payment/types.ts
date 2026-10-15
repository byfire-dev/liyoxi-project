import type { FulfillResult } from "@liyoxi/contract";
import type { Events } from "../../events/index.js";
import type { Flow } from "../../flow/index.js";
import type { BizNoIssuer, Clock, IdentityContext, Tx } from "../../kernel/index.js";
import type { Timers } from "../../timers/index.js";
import type { Fulfillment } from "../subscription/index.js";

export const APPLY_STEPS = [
  "order.pay",
  "txn.apply",
  "order.fulfill",
  "exception.open",
  "timers.cancel",
] as const;
export type ApplyStep = (typeof APPLY_STEPS)[number];
export type PaymentExceptionKind =
  | "payer_mismatch"
  | "amount_mismatch"
  | "duplicate_receipt"
  | "paid_after_cancel"
  | "fulfillment_blocked";
export interface PaymentDeps {
  readonly clock: Clock;
  readonly events: Pick<Events, "emit">;
  readonly flow: Pick<Flow, "transition">;
  readonly fulfillment: Fulfillment;
  readonly timers: Pick<Timers, "cancel">;
  readonly bizNo: BizNoIssuer;
  readonly onStep?: (step: ApplyStep) => void | Promise<void>;
}
export interface ApplyPaymentInput {
  readonly paymentTxnId: string;
  /** 不给即系统入账；对公确认传财务上下文。 */
  readonly ctx?: IdentityContext;
}
export type ApplyPaymentResult =
  | {
      readonly status: "applied";
      readonly billingOrderId: string;
      readonly fulfillment: FulfillResult;
    }
  | {
      readonly status: "exception";
      readonly billingOrderId: string;
      readonly kind: PaymentExceptionKind;
      readonly paymentExceptionId: string;
    }
  | { readonly status: "skipped"; readonly billingOrderId: string };
export interface ApplyPaymentOutcome {
  readonly result: ApplyPaymentResult;
  readonly replayed: boolean;
}
export interface Payment {
  applyPayment(tx: Tx, input: ApplyPaymentInput): Promise<ApplyPaymentOutcome>;
}
