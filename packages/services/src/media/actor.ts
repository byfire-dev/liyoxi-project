import type { StaffContext, MerchantStanding } from "../authz/index.js";
import type { IdentityContext } from "../kernel/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
export interface MediaActor {
  readonly audit?: AuditRequestMeta;
  readonly identity: IdentityContext;
  readonly staff?: StaffContext;
  readonly merchant?: {
    readonly standing: MerchantStanding;
    readonly entityId: string;
    readonly storeId: string;
  };
}
