// 后台：套餐积分与财务（docs/api/a07-billing-finance.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as billingParams from "./billing-params.js";
import * as financeConfigRevisions from "./finance-config-revisions.js";
import * as invoiceRequests from "./invoice-requests.js";
import * as paymentExceptions from "./payment-exceptions.js";
import * as paymentOrders from "./payment-orders.js";
import * as paymentTransactions from "./payment-transactions.js";
import * as planRevisions from "./plan-revisions.js";
import * as plans from "./plans.js";
import * as pointAccounts from "./point-accounts.js";
import * as pointAdjustmentRequests from "./point-adjustment-requests.js";
import * as pointPacks from "./point-packs.js";
import * as pricingChanges from "./pricing-changes.js";
import * as reconciliations from "./reconciliations.js";
import * as refundRequests from "./refund-requests.js";
import * as subscriptionTerms from "./subscription-terms.js";
import * as termExtensionRequests from "./term-extension-requests.js";
import * as transferProofs from "./transfer-proofs.js";

export const A07_BILLING_FINANCE = defineRouteDoc("a07-billing-finance", [
  billingParams,
  financeConfigRevisions,
  invoiceRequests,
  paymentExceptions,
  paymentOrders,
  paymentTransactions,
  planRevisions,
  plans,
  pointAccounts,
  pointAdjustmentRequests,
  pointPacks,
  pricingChanges,
  reconciliations,
  refundRequests,
  subscriptionTerms,
  termExtensionRequests,
  transferProofs,
]);

export * from "./purchase.schemas.js";
export * from "./payment-orders.js";
export * from "./payment-transactions.js";
export * from "./transfer-proofs.js";
export * from "./error-details.js";
export * from "./plans.schemas.js";
export * from "./plans.js";
export * from "./plan-revisions.js";
export * from "./parameters.schemas.js";
export * from "./billing-params.js";
export * from "./pricing-changes.js";
