import type { StaffBrief } from "@liyoxi/contract";
import type { Ledger } from "../billing/index.js";
import type { Events } from "../events/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "../delivery/index.js";
import type { AssignmentPool } from "../staff/index.js";
import type { Timers } from "../timers/index.js";

/** 仅由组合根接真实公开函数；与 a 的推导绑定分开，旧调用方不需要开工依赖。 */
export interface OrderStartBinding extends DeliveryCoreDeps {
  readonly events: Events;
  readonly timers: Timers;
  readonly ledger: Pick<Ledger, "capture">;
  readonly recommendStaff: (tx: Tx, pool: AssignmentPool) => Promise<StaffBrief | null>;
  readonly assignManager: (
    tx: Tx,
    ctx: IdentityContext,
    input: { storeId: string; staffId: string },
  ) => Promise<unknown>;
}
const scopes: Array<{ binding: OrderStartBinding }> = [];
export function bindOrderStart(binding: OrderStartBinding): () => void {
  const scope = { binding };
  scopes.push(scope);
  return () => {
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
  };
}
export function boundOrderStart(): OrderStartBinding {
  const scope = scopes.at(-1);
  if (!scope) throw new AppError("INTERNAL", { message: "order 开工尚未绑定运行时" });
  return scope.binding;
}
