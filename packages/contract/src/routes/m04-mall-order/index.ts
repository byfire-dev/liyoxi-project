// 商家端：商城、选剧单与订购（docs/api/m04-mall-order.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as cancelRequests from "./cancel-requests.js";
import * as cartItems from "./cart-items.js";
import * as dramas from "./dramas.js";
import * as favorites from "./favorites.js";
import * as home from "./home.js";
import * as mallConfig from "./mall-config.js";
import * as orderItems from "./order-items.js";
import * as orders from "./orders.js";
import * as todos from "./todos.js";

export const M04_MALL_ORDER = defineRouteDoc("m04-mall-order", [
  cancelRequests,
  cartItems,
  dramas,
  favorites,
  home,
  mallConfig,
  orderItems,
  orders,
  todos,
]);

export * from "./home.js";
export * from "./mall-config.js";
export * from "./dramas.js";
export * from "./mall.schemas.js";
export * from "./error-details.js";
export * from "./orders.js";
export * from "./order.schemas.js";
export * from "./banner.schemas.js";
