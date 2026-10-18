import type { StaffContext } from "../../authz/index.js";
import type { AuditRequestMeta } from "../../audit/index.js";
import type { Alerts, IdentityContext, SessionMutex, Tx } from "../../kernel/index.js";
import type { StaffBrief } from "@liyoxi/contract";
export interface RetentionActor {
  identity: IdentityContext;
  staff: StaffContext;
  meta: AuditRequestMeta;
}
export interface RetentionOptions {
  sessionMutex: SessionMutex;
  alerts: Alerts;
  staffBriefs(tx: Tx, ids: readonly string[]): Promise<StaffBrief[]>;
  sweep?: {
    parameters(): Promise<{ mode: "list_only" | "auto"; maxObjects: number; maxBytes: bigint }>;
    remindDemand(tx: Tx, demandId: string): Promise<number>;
  };
}
