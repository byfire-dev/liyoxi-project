/** W118 PR1四页十一态，旧28态保留。 */
export const CATALOG_SCENES = [
  { name: "home-owner", route: "pages/home/index" },
  { name: "home-clerk", route: "pages/home/index" },
  { name: "home-guest", route: "pages/home/index" },
  { name: "mall-default", route: "pages/mall/index" },
  { name: "mall-end", route: "pages/mall/index" },
  { name: "mall-empty", route: "pages/mall/index" },
  {
    name: "detail-owner",
    route: "sub/catalog/detail/index?dramaId=00000000-0000-4000-8000-000000000001",
  },
  { name: "cart-default", route: "pages/cart/index" },
  { name: "cart-invalid", route: "pages/cart/index" },
  { name: "cart-price-changed", route: "pages/cart/index" },
  { name: "cart-clerk", route: "pages/cart/index" },
] as const;
