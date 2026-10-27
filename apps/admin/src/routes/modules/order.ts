// 订单模块的路由清单。页面包把自己的路由文件放在 src/routes/order/ 下，在这里加一行；
// 一个模块一个清单，别的模块不用动（计划 第 9.3 节）。写法见 apps/admin/README.md“加一个页面”。
import { receiptsRoute } from "../order/receipts";
import { ordersRoute } from "../order/list";
import { orderDetailRoute } from "../order/detail";
import { renewalsRoute } from "../order/renewals";
export const orderRoutes = [receiptsRoute, ordersRoute, orderDetailRoute, renewalsRoute] as const;
