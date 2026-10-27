// 履约的依赖与步骤名（W1-11a）。
import type { Events } from "../../events/index.js";
import type { Clock } from "../../kernel/index.js";
import type { LedgerStep } from "../ledger/types.js";

export type PlanRefundRule = "window" | "qualification_failed" | "override";
export interface PlanRefundPreview {
  readonly termId: string;
  readonly entityId: string;
  readonly termStatus: string;
  readonly termStartsAt: string;
  readonly termEndsAt: string;
  readonly windowDeadline: string | null;
  readonly withinWindow: boolean;
  readonly unused: boolean;
  readonly upgraded: boolean;
  readonly refundableFen: number;
  readonly billingOrderIds: readonly string[];
  readonly addonAvailable: number;
  readonly usage: { readonly heldOrUsedHolds: number; readonly lotsTouched: number };
  readonly sideEffects: {
    readonly revokePoints: number;
    readonly cancelSchedules: number;
    readonly addonWillSuspend: number;
    readonly nextTermWillStartNow: boolean;
  };
}
export interface RevokeTermResult {
  readonly revokedPoints: number;
  readonly cancelledSchedules: number;
  readonly billingOrderIds: readonly string[];
}

/** 履约自己的写步骤 */
export const FULFILL_OWN_STEPS = ["term.insert", "schedule.insert", "promo.insert"] as const;
export type FulfillStep = LedgerStep | (typeof FULFILL_OWN_STEPS)[number];
/**
 * 当前套餐履约可达的账本写步骤：推进、发首月、恢复闸门与履约登记。
 * 不传 hold 或 conversions，不会新建/修改冻结单、写分摊或转加购；冻结单一族的完整覆盖在 ledger/fault.test.ts。
 * 独立列出而不展开 LEDGER_STEPS，避免账本新增操作误变成履约的必达步骤；实际新可达步骤仍会被用例的集合等式抓住。
 */
const FULFILL_LEDGER_STEPS = [
  "lot.insert",
  "schedule.grant",
  "operation.insert",
  "lot.update",
  "entry.insert",
  "account.update",
  "term.update",
  "subscription_event.insert",
  "event.emit",
] as const satisfies readonly LedgerStep[];
/** 一次履约会经过的全部步骤名：故障注入的用例按它下断点 */
export const FULFILL_STEPS: readonly FulfillStep[] = [
  ...FULFILL_OWN_STEPS,
  ...FULFILL_LEDGER_STEPS,
];

/** 与账本的依赖同形（可以直接交给账本内部的函数），步骤名多三个 */
export interface FulfillDeps {
  /** 业务时钟：账本时钟在拿到账户锁之后取它 */
  readonly clock: Clock;
  readonly events: Pick<Events, "emit">;
  /** 只有用例会给：每个写步骤之后调一次，抛错即在那一步中断（故障注入） */
  readonly onStep?: (step: FulfillStep) => void | Promise<void>;
}
