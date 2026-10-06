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
