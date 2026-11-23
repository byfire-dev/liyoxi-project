import type { FinanceConfigCreateBody, FinanceConfigViewSchema } from "@liyoxi/contract";
export type ConfigRevision = ReturnType<typeof FinanceConfigViewSchema.parse>;
export type ConfigKey = ConfigRevision["configKey"];
export type ConfigDecision = "approve" | "reject" | "withdraw";
export type ConfigCommand = ConfigDecision | "create";
export type Controls = Extract<FinanceConfigCreateBody, { configKey: "controls" }>["payload"];
export type PurchasePolicy = Extract<
  FinanceConfigCreateBody,
  { configKey: "purchase_policy" }
>["payload"];
export type PolicyRule = PurchasePolicy["rules"][number];
