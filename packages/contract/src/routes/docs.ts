// 全部接口文档的路由，一份文档一个目录。顺序：商家端、后台、下载页、回调与探活（07 第 1 节）。
// 加一份接口文档：建目录与 index.ts，在这里加一行 import，并放进下面的数组。
import { M01_ACCOUNT } from "./m01-account/index.js";
import { M02_TENANT } from "./m02-tenant/index.js";
import { M03_PROFILE_ASSET } from "./m03-profile-asset/index.js";
import { M04_MALL_ORDER } from "./m04-mall-order/index.js";
import { M05_DELIVERY_PUBLISH } from "./m05-delivery-publish/index.js";
import { M06_AD } from "./m06-ad/index.js";
import { M07_BILLING } from "./m07-billing/index.js";
import { M08_SUPPORT_MISC } from "./m08-support-misc/index.js";
import { A01_SYSTEM } from "./a01-system/index.js";
import { A02_WORKBENCH_REPORT } from "./a02-workbench-report/index.js";
import { A03_MERCHANT } from "./a03-merchant/index.js";
import { A04_CONTENT } from "./a04-content/index.js";
import { A05_ORDER_DELIVERY } from "./a05-order-delivery/index.js";
import { A06_PUBLISH } from "./a06-publish/index.js";
import { A07_BILLING_FINANCE } from "./a07-billing-finance/index.js";
import { A08_SUPPORT } from "./a08-support/index.js";
import { A09_OPS } from "./a09-ops/index.js";
import { P01_PORTAL } from "./p01-portal/index.js";
import { H01_HOOKS } from "./h01-hooks/index.js";

export const ROUTE_DOCS = [
  M01_ACCOUNT,
  M02_TENANT,
  M03_PROFILE_ASSET,
  M04_MALL_ORDER,
  M05_DELIVERY_PUBLISH,
  M06_AD,
  M07_BILLING,
  M08_SUPPORT_MISC,
  A01_SYSTEM,
  A02_WORKBENCH_REPORT,
  A03_MERCHANT,
  A04_CONTENT,
  A05_ORDER_DELIVERY,
  A06_PUBLISH,
  A07_BILLING_FINANCE,
  A08_SUPPORT,
  A09_OPS,
  P01_PORTAL,
  H01_HOOKS,
] as const;
