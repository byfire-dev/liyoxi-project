import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { readTableSearch } from "../../../lib/table-search";
import { choice, idValue } from "../payments/model";
import type { ConfigCommand, ConfigDecision, ConfigKey, ConfigRevision } from "./types";

export const configLabels = {
  bank_account: "对公收款账户",
  purchase_policy: "购买入口策略",
  controls: "财务内控",
} as const;
export const stateLabels = {
  pending: "待审批",
  scheduled: "已批准，待生效",
  effective: "当前生效",
  superseded: "已被替代",
  rejected: "已驳回",
  withdrawn: "已撤回",
} as const;
export const actionLabels = { approve: "批准", reject: "驳回", withdraw: "撤回" } as const;
export const configKeys = Object.keys(configLabels) as ConfigKey[];
export function settingsSearch(raw: Record<string, unknown>) {
  const table = readTableSearch(raw);
  return {
    page: table.page,
    pageSize: table.pageSize,
    tab: choice(raw.tab, ["current", "history"] as const) ?? "current",
    configKey: choice(raw.configKey, configKeys),
    id: idValue(raw.id),
  };
}
export const canPropose = (access: AccessSnapshot | null) =>
  hasModuleLevel(access, "finance") && canAction(access, "finance.config.propose");
export function configDecisions(
  value: ConfigRevision,
  access: AccessSnapshot | null,
): ConfigDecision[] {
  if (
    !access ||
    !hasModuleLevel(access, "finance") ||
    value.state !== "pending" ||
    value.approval.status !== "pending" ||
    value.approval.kind !== "finance_config_change"
  )
    return [];
  return (["approve", "reject", "withdraw"] as const).filter(
    (action) =>
      value.actions.includes(action) &&
      value.approval.actions.includes(action) &&
      (action === "withdraw" ||
        (canAction(access, "finance.config.approve") &&
          value.approval.requester?.staffId !== access.staff.id)),
  );
}
export const currentConfig = (items: readonly ConfigRevision[], key: ConfigKey) =>
  items.find((item) => item.configKey === key && item.state === "effective") ?? null;

/** 私有写意图：同正文失败保留key；同步闩、卸载取消和代际检查。银行输入仅留在此页面内存。 */
export function createConfigIntent(makeKey = () => newIdempotencyKey("finance-config")) {
  const keys = new Map<ConfigCommand, { signature: string; key: string }>();
  let busy = false,
    active = true,
    generation = 0,
    controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      generation++;
      busy = false;
      controller.abort();
      keys.clear();
    },
    async submit<T>(
      action: ConfigCommand,
      body: unknown,
      send: (key: string, signal: AbortSignal) => Promise<T>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(body),
        old = keys.get(action),
        intent = old?.signature === signature ? old : { signature, key: makeKey() };
      keys.set(action, intent);
      busy = true;
      const own = generation,
        signal = controller.signal;
      try {
        const value = await send(intent.key, signal);
        if (!active || signal.aborted || own !== generation) return undefined;
        keys.delete(action);
        return value;
      } catch (error) {
        if (active && !signal.aborted && own === generation) throw error;
        return undefined;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
