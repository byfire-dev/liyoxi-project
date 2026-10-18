import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { paramsAt } from "../../config/index.js";
const keys = {
  plan_new: "invoice.item_name.plan_new",
  plan_renew: "invoice.item_name.plan_renew",
  plan_upgrade: "invoice.item_name.plan_upgrade",
  topup: "invoice.item_name.topup",
} as const;
export async function invoiceItemName(tx: Tx, orderType: string, now: Date, required = true) {
  if (!Object.hasOwn(keys, orderType)) throw new AppError("PRECONDITION_CHANGED");
  const key = keys[orderType as keyof typeof keys],
    values = await paramsAt(tx, [key], now),
    value = values[key];
  if (required && value === null)
    throw new AppError("PRECONDITION_CHANGED", { message: "开票项目尚未配置" });
  return value;
}
