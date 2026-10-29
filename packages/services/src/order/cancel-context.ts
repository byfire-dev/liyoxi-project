import type { CancelQuote, CancelRecheckEntry } from "@liyoxi/contract";
import type { Approval } from "../approval/index.js";
import type { StaffContext } from "../authz/index.js";
import { SYSTEM_SCOPE } from "../authz/index.js";
import type { Ledger } from "../billing/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import { AppError } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import type { Sla } from "../sla/index.js";
import type { Timers } from "../timers/index.js";

export interface CancelDeps {
  /** 既有广告调用方无需履约运行时；包含工单的统一执行由组合根提供真实装配。 */
  assembly?: Assembly;
  readApprovalRefs?: (
    tx: Tx,
    input: { approvalRequestId: string; entityId: string; storeId: string },
  ) => Promise<readonly { serviceTicketId: string; ticketNo: string; status: string }[]>;
  tx: TxRunner;
  clock: Clock;
  approval: Approval;
  flow: Flow;
  ledger: Ledger;
  events: Events;
  timers: Timers;
  sla: Sla;
}
export interface CancelActor {
  ctx: IdentityContext;
  staff?: StaffContext;
}
/** 应用组合只在固定的两个提交阶段运行；不把其他 L3 owner 注入 order。 */
export interface AdCancelSubmissionTarget {
  readonly actor: CancelActor;
  readonly approvalId: string;
  readonly adId: string;
  readonly entityId: string;
  readonly storeId: string;
}
export interface AdCancelSubmissionCompanion {
  beforeAccount(tx: Tx, target: AdCancelSubmissionTarget): Promise<void>;
  afterCreated(tx: Tx, target: AdCancelSubmissionTarget): Promise<void>;
}
export interface CancelCall {
  deps: CancelDeps;
  actor: CancelActor;
  requestId?: string;
  quote?: CancelQuote;
  auto?: boolean;
  submissionCompanion?: AdCancelSubmissionCompanion;
  submissionTarget?: AdCancelSubmissionTarget;
}
// 与 qualification 同形的事务绑定；静态 kind 不缓存某个 API/worker 的实例。
const calls = new WeakMap<Tx, CancelCall>();
export async function withCancelCall<T>(tx: Tx, call: CancelCall, fn: () => Promise<T>) {
  if (calls.has(tx)) throw new AppError("INTERNAL", { message: "取消用例不能重入" });
  calls.set(tx, call);
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}
export function cancelCall(tx: Tx) {
  const call = calls.get(tx);
  if (!call) throw new AppError("INTERNAL", { message: "广告取消必须从 order 公口进入" });
  return call;
}
export const cancelScope = (actor: CancelActor) => actor.staff?.scope ?? SYSTEM_SCOPE;
export class CancelRecheckError extends AppError {
  constructor(
    readonly requestId: string,
    readonly phase: "approve" | "execute",
    readonly entry: CancelRecheckEntry,
  ) {
    super("PRECONDITION_CHANGED", { details: { diffs: entry.diffs } });
  }
}
const passes = new WeakSet<object>();
export function cancelPass() {
  const pass = Object.freeze({});
  passes.add(pass);
  return pass;
}
export function checkedCancel(args: unknown) {
  return typeof args === "object" && args !== null && passes.has(args);
}
