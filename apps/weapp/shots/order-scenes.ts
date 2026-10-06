export const ORDER_SCENES = [
  {
    name: "checkout-default",
    route: "sub/order/checkout/index?dramaIds=00000000-0000-4000-8000-000000000001",
  },
  {
    name: "checkout-points",
    route: "sub/order/checkout/index?dramaIds=00000000-0000-4000-8000-000000000001",
  },
  {
    name: "checkout-qualification",
    route: "sub/order/checkout/index?dramaIds=00000000-0000-4000-8000-000000000001",
  },
  { name: "orders-default", route: "sub/order/orders/index" },
  {
    name: "checkout-quote-changed",
    route: "sub/order/checkout/index?dramaIds=00000000-0000-4000-8000-000000000001",
  },
  { name: "orders-empty", route: "sub/order/orders/index" },
  {
    name: "order-detail-default",
    route: "sub/order/order-detail/index?orderId=00000000-0000-4000-8000-000000000401",
  },
  {
    name: "order-detail-producing",
    route: "sub/order/order-detail/index?orderId=00000000-0000-4000-8000-000000000401",
  },
  {
    name: "order-success",
    route: "sub/order/result/index?type=order&orderId=00000000-0000-4000-8000-000000000401",
  },
] as const;
