export const CONTRACT_SCENES = [
  { name: "contracts-old-version", route: "sub/billing/contracts/index" },
  { name: "contracts-clerk", route: "sub/billing/contracts/index" },
  { name: "contracts-license-list", route: "sub/billing/contracts/index" },
  { name: "contracts-license-empty", route: "sub/billing/contracts/index" },
  { name: "contracts-license-history", route: "sub/billing/contracts/index" },
  { name: "contracts-license-generating", route: "sub/billing/contracts/index" },
  { name: "contracts-license-unavailable", route: "sub/billing/contracts/index" },
  { name: "contracts-license-clerk", route: "sub/billing/contracts/index" },
  {
    name: "contracts-license-order",
    route: "sub/billing/contracts/index?orderId=00000000-0000-4000-8000-000000000150",
  },
] as const;
