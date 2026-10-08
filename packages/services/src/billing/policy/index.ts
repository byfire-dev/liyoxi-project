import { getPurchasePolicy as compute } from "@liyoxi/shared/purchase-policy";
import type { PurchasePolicy } from "@liyoxi/contract";
import { paramsAt, type Config } from "../../config/index.js";
import type { Tx } from "../../kernel/index.js";
import { financeConfigAt } from "../finance-config/index.js";
export interface PurchaseClient {
  platform: string;
  appVersion?: string;
}
export async function getPurchasePolicy(
  tx: Tx,
  config: Config,
  entityId: string,
  at: Date,
  client: PurchaseClient,
  type?: string,
  amountFen?: number,
): Promise<PurchasePolicy> {
  const finance = await financeConfigAt(tx, at),
    params = await paramsAt(
      tx,
      ["payment.bank_transfer.min_fen", "payment.wechat.advise_transfer_above_fen"],
      at,
    );
  return compute(
    {
      platform: client.platform,
      ...(client.appVersion === undefined ? {} : { appVersion: client.appVersion }),
      entityId,
      ...(type === undefined ? {} : { type }),
      ...(amountFen === undefined ? {} : { amountFen }),
      providers: { wechatPayConfigured: false },
      bankAccountConfigured: finance.bank !== null,
      bankMinFen: params["payment.bank_transfer.min_fen"],
      adviseTransferAboveFen: params["payment.wechat.advise_transfer_above_fen"],
    },
    finance.rules,
    finance.controls,
  );
}

/** 通知不知道打开设备；D6的plan类别对应实际三种套餐交易，不猜版本或金额条件。 */
export async function getNotifyPurchaseMode(
  tx: Tx,
  entityId: string,
  at: Date,
): Promise<PurchasePolicy["mode"]> {
  const finance = await financeConfigAt(tx, at);
  let mode: PurchasePolicy["mode"] = "in_app";
  for (const platform of ["ios", "android", "harmony", "windows", "mac"]) {
    for (const type of ["plan_new", "plan_renew", "plan_upgrade"]) {
      const candidate = compute(
        {
          platform,
          entityId,
          type,
          providers: { wechatPayConfigured: false },
          bankAccountConfigured: finance.bank !== null,
          bankMinFen: 0,
        },
        finance.rules,
        finance.controls,
      ).mode;
      if (candidate === "hidden") return "hidden";
      if (candidate === "offline_contract") mode = candidate;
    }
  }
  return mode;
}
