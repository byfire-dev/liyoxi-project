import type { AccountChangeCreateBody } from "@liyoxi/contract";
import type { Approval } from "../approval/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import type {
  Assembly,
  Clock,
  IdempotencyContext,
  IdentityContext,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import type { pendingAccountChanges } from "./empty-account.js";
import type { Media } from "../media/index.js";
import type { NotifyDispatcherService } from "../notify/index.js";
import type { Keyring } from "../security/index.js";
export interface AccountChangeDeps {
  tx: TxRunner;
  clock: Clock;
  flow: Flow;
  events: Pick<Events, "emit">;
  assembly: Assembly;
  keyring: () => Keyring;
  approval?: Pick<Approval, "submit" | "approve" | "reject" | "withdraw" | "decisionView">;
  media?: Pick<Media, "link">;
  notify?: Pick<NotifyDispatcherService, "sendDirect">;
  smsConfigured?: () => boolean;
}
export interface AccountChangeOptions {
  meta: AuditRequestMeta;
}
export interface AccountChangeWriteOptions extends AccountChangeOptions {
  idem: IdempotencyContext;
}
export interface AccountChangeCall {
  deps: AccountChangeDeps;
  ctx: IdentityContext;
  staff: StaffContext;
  meta: AuditRequestMeta;
  input?: AccountChangeCreateBody;
  requestId: string;
  newOwnerUserId?: string;
  newOwnerAccountCreated?: boolean;
  occupantId?: string | null;
  occupantChanges?: Awaited<ReturnType<typeof pendingAccountChanges>>;
  oldPhone?: string;
  confirm?: { requestNo: string; newPhoneMask?: string | null };
}
const calls = new WeakMap<Tx, AccountChangeCall>();
export async function withAccountChangeCall<T>(
  tx: Tx,
  state: AccountChangeCall,
  fn: () => Promise<T>,
): Promise<T> {
  if (calls.has(tx)) throw new TypeError("账号变更领域用例不能重入");
  calls.set(tx, state);
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}
export function accountChangeCall(tx: Tx): AccountChangeCall {
  const state = calls.get(tx);
  if (!state) throw new TypeError("账号变更生效必须从本域真实用例进入");
  return state;
}
