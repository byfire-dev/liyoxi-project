import { createConfig } from "../config/index.js";
import { calendarDate } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { currentNotificationFact, dispatchFact } from "./dispatch.js";
import { ASSET_DEMAND_SPEC } from "./registry.js";

/** media拥有due_date扫描；通知拥有场景、当前成员范围、持久去重和所有投递。 */
export async function remindAssetDemand(tx: Tx, deps: NotifyDispatchDeps, id: string) {
  const fact = await currentNotificationFact(tx, deps, ASSET_DEMAND_SPEC, id);
  if (
    !fact ||
    fact.status !== "open" ||
    !fact.targetDate ||
    fact.targetDate > calendarDate(deps.clock.now())
  )
    return 0;
  return dispatchFact(
    tx,
    { ...deps, params: createConfig({ db: tx, clock: deps.clock, redis: null }).params },
    ASSET_DEMAND_SPEC,
    { ...fact, summary: `${fact.name}已到约定日期，请查看拍摄说明并补充素材。` },
    { node: "T-0", rule: "asset_request.due" },
  );
}
