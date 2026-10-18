// 商家端：套餐、积分、付款与发票（docs/api/m07-billing.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as invoiceRequests from "./invoice-requests.js";
import * as paymentOrders from "./payment-orders.js";
import * as plans from "./plans.js";
import * as pointLedgerEntries from "./point-ledger-entries.js";
import * as pointPacks from "./point-packs.js";
import * as purchasePolicy from "./purchase-policy.js";
import * as wallet from "./wallet.js";

export const M07_BILLING = defineRouteDoc("m07-billing", [
  invoiceRequests,
  paymentOrders,
  plans,
  pointLedgerEntries,
  pointPacks,
  purchasePolicy,
  wallet,
]);

export * from "./purchase.schemas.js";
export * from "./wallet.js";
export * from "./purchase-policy.js";
export * from "./plans.js";
export * from "./payment-orders.js";
export * from "./error-details.js";
export * from "./point-packs.js";

export * from "./invoices.schemas.js";
export * from "./invoice-requests.js";
export * from "./channel-read.schemas.js";
export * from "./point-ledger-entries.js";
