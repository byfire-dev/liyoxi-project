// 财务模块的路由清单。页面包把自己的路由文件放在 src/routes/finance/ 下，在这里加一行；
// 一个模块一个清单，别的模块不用动（计划 第 9.3 节）。写法见 apps/admin/README.md“加一个页面”。
import { creditAdjustRoute } from "../finance/credit-adjust";
import { invoicesRoute } from "../finance/invoices";
import { paymentsRoute } from "../finance/payments";
import { refundsRoute } from "../finance/refunds";
import { reconcileRoute } from "../finance/reconcile";
import { financeSettingsRoute } from "../finance/settings";
export const financeRoutes = [
  paymentsRoute,
  refundsRoute,
  creditAdjustRoute,
  reconcileRoute,
  invoicesRoute,
  financeSettingsRoute,
] as const;
