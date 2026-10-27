export const LEDGER_SCENES = [
  ...["list", "loading", "empty", "error", "more", "filters", "clerk", "forbidden"].map(
    (state) => ({
      name: `ledger-${state}`,
      route: "sub/billing/ledger/index",
    }),
  ),
  { name: "ledger-entry", route: "sub/billing/wallet/index" },
] as const;
