// 一次账本操作的登记与落库（W1-10）。依据：07 分组 第 2.15 节“写入顺序”、第 2.16、3.3、3.4 节；D1 第 7.1 节。
// 账本的写只有这一个出口：先在内存里算完桶移动与操作后的余额，再按固定顺序写——
//   新批次 →（发放计划改成已发放）→ 操作行 → 已有批次的桶、逐批次的流水 → 账户缓存与 last_op_at。
// 冻结单与分摊（写入顺序第 2、6、7 步的另一半）随冻结一族加进来。
import { parseLedgerTitleArgs } from "@liyoxi/contract";
import type { LedgerTitleArgs, LedgerTitleCode } from "@liyoxi/contract";
import type {
  BILLING_SUB_STATUS,
  EnumValue,
  LEDGER_OPERATION_OP_TYPE,
  LEDGER_OPERATION_REF_TYPE,
  POINT_LOT_SOURCE_TYPE,
} from "@liyoxi/contract/enums";
import type { LedgerOperation } from "@liyoxi/db";
import type { LocalDate } from "@liyoxi/shared/time";

import { actorColumns, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { toDateColumn } from "./context.js";
import type { LedgerClock } from "./context.js";
import { LedgerError } from "./types.js";
import type { Bucket, LedgerDeps, LedgerStep, LotKind } from "./types.js";

/** 账户行里账本要读写的列。进入时读一次，之后随每次写同步更新 */
export interface AccountState {
  readonly entityId: string;
  subStatus: EnumValue<typeof BILLING_SUB_STATUS>;
  currentSubscriptionTermId: string | null;
  planAvailableQty: number;
  addonAvailableQty: number;
  heldTotalQty: number;
  nextDueAt: Date | null;
  lastExpiredQty: number | null;
  lastExpiredAt: Date | null;
}

/** 流水要带的批次信息 */
export interface LotRef {
  readonly id: string;
  readonly kind: string;
  readonly planId: string | null;
  readonly subscriptionTermId: string | null;
}

export interface NewLot {
  readonly kind: LotKind;
  readonly sourceType: EnumValue<typeof POINT_LOT_SOURCE_TYPE>;
  readonly sourceId: string;
  readonly sourceNo?: number;
  readonly subscriptionTermId: string | null;
  readonly planId: string | null;
  readonly planRevisionId: string | null;
  readonly expiresAt: Date | null;
  /** 入账数量，入账后不变 */
  readonly qty: number;
  /** 入账成本（分） */
  readonly costBasisFen: number;
}

/** 已有批次上的一次桶到桶移动 */
export interface BucketMove {
  readonly lot: LotRef;
  readonly from: Exclude<Bucket, "external">;
  readonly to: Exclude<Bucket, "external">;
  readonly qty: number;
  readonly pointHoldId?: string | null;
}

export type OperationTitle = {
  [C in LedgerTitleCode]: { readonly code: C; readonly args: LedgerTitleArgs<C> };
}[LedgerTitleCode];

export interface OperationDraft {
  readonly opKey: string;
  readonly opType: EnumValue<typeof LEDGER_OPERATION_OP_TYPE>;
  readonly ref: { readonly type: EnumValue<typeof LEDGER_OPERATION_REF_TYPE>; readonly id: string };
  /** 业务生效时刻：实时操作取账本时钟，到点类取逻辑时间 */
  readonly occurredAt: Date;
  readonly bizDate: LocalDate;
  readonly title: OperationTitle | null;
  /** 操作人与请求号 */
  readonly ctx: IdentityContext;
  readonly newLots?: readonly NewLot[];
  readonly moves?: readonly BucketMove[];
  /** 新批次插入之后、操作行之前：发放计划在这里改成已发放并指向批次 */
  readonly afterLots?: (lotIds: readonly string[]) => Promise<void>;
  /** 随这次操作一起改的账户列：订阅状态与当前周期（同一条 UPDATE，库里有 CHECK）、最近一次清零 */
  readonly accountPatch?: Partial<
    Pick<
      AccountState,
      "subStatus" | "currentSubscriptionTermId" | "lastExpiredQty" | "lastExpiredAt"
    >
  >;
  /** 操作之后闸门开不开：订阅生效且不在退款处理中。可花积分 = 开 ? 套餐可用 + 加购可用 : 0 */
  readonly gateOpen: boolean;
}

export interface WrittenOperation {
  readonly id: string;
  readonly lotIds: readonly string[];
  readonly planDeltaQty: number;
  readonly addonDeltaQty: number;
  readonly spendableAfterQty: number;
  readonly heldAfterQty: number;
}

const COLUMN = {
  available: "availableQty",
  held: "heldQty",
  consumed: "consumedQty",
  expired: "expiredQty",
  revoked: "revokedQty",
  converted_out: "convertedOutQty",
  adjusted_out: "adjustedOutQty",
} as const satisfies Record<Exclude<Bucket, "external">, string>;

export const reached = async (deps: LedgerDeps, step: LedgerStep): Promise<void> => {
  await deps.onStep?.(step);
};

/** 账户行 → 账本读写的那几列 */
export async function loadAccount(tx: Tx, entityId: string): Promise<AccountState> {
  const row = await tx.billingAccount.findUniqueOrThrow({ where: { entityId } });
  return {
    entityId,
    subStatus: row.subStatus as AccountState["subStatus"],
    currentSubscriptionTermId: row.currentSubscriptionTermId,
    planAvailableQty: row.planAvailableQty,
    addonAvailableQty: row.addonAvailableQty,
    heldTotalQty: row.heldTotalQty,
    nextDueAt: row.nextDueAt,
    lastExpiredQty: row.lastExpiredQty,
    lastExpiredAt: row.lastExpiredAt,
  };
}

/** 按操作键取已登记的操作：有即这次是重放 */
export const findOperation = (tx: Tx, opKey: string): Promise<LedgerOperation | null> =>
  tx.ledgerOperation.findUnique({ where: { opKey } });

/** 主体级闸门：任一预约或生效的周期挂着退款申请，即“退款处理中”（m07 第 2.0 节） */
export async function isRefundPending(tx: Tx, entityId: string): Promise<boolean> {
  const marked = await tx.subscriptionTerm.count({
    where: { entityId, status: { in: ["scheduled", "active"] }, refundRequestId: { not: null } },
  });
  return marked > 0;
}

function positive(qty: number, what: string): number {
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new LedgerError("guard", `${what}必须是正整数`, { qty });
  }
  return qty;
}

/**
 * 写一次账本操作。调用方已持有账户锁、已 advance、已按操作键查过没有登记。
 * account 是进入时读出的账户状态：这里按桶移动算出增量，写库后把它改成新值。
 */
export async function writeOperation(
  tx: Tx,
  deps: LedgerDeps,
  clock: LedgerClock,
  account: AccountState,
  draft: OperationDraft,
): Promise<WrittenOperation> {
  const newLots = draft.newLots ?? [];
  const moves = draft.moves ?? [];
  // 套餐可用只算当前周期的批次（07 分组 第 2.8 节）
  const inPlanCache = (lot: Pick<LotRef, "kind" | "subscriptionTermId">): boolean =>
    lot.kind === "plan" && lot.subscriptionTermId === account.currentSubscriptionTermId;

  // 1. 先在内存里算完
  let planDelta = 0;
  let addonDelta = 0;
  let heldDelta = 0;
  const available = (lot: Pick<LotRef, "kind" | "subscriptionTermId">, qty: number): void => {
    if (lot.kind === "addon") addonDelta += qty;
    else if (inPlanCache(lot)) planDelta += qty;
  };
  for (const lot of newLots) available(lot, positive(lot.qty, "入账数量"));
  const perLot = new Map<string, Partial<Record<(typeof COLUMN)[keyof typeof COLUMN], number>>>();
  for (const move of moves) {
    positive(move.qty, "移动数量");
    if (move.from === "available") available(move.lot, -move.qty);
    if (move.to === "available") available(move.lot, move.qty);
    if (move.from === "held") heldDelta -= move.qty;
    if (move.to === "held") heldDelta += move.qty;
    const delta = perLot.get(move.lot.id) ?? {};
    delta[COLUMN[move.from]] = (delta[COLUMN[move.from]] ?? 0) - move.qty;
    delta[COLUMN[move.to]] = (delta[COLUMN[move.to]] ?? 0) + move.qty;
    perLot.set(move.lot.id, delta);
  }
  const planAfter = account.planAvailableQty + planDelta;
  const addonAfter = account.addonAvailableQty + addonDelta;
  const heldAfter = account.heldTotalQty + heldDelta;
  const spendableAfter = draft.gateOpen ? planAfter + addonAfter : 0;
  const title =
    draft.title === null
      ? null
      : { code: draft.title.code, args: parseLedgerTitleArgs(draft.title.code, draft.title.args) };
  const operationId = uuidv7();
  const stamp = { occurredAt: draft.occurredAt, bizDate: toDateColumn(draft.bizDate) };
  const createdAt = clock.now;

  // 3. 新入账的批次（可用 = 入账数量）
  const lots = newLots.map((lot) => ({ ...lot, id: uuidv7() }));
  if (lots.length > 0) {
    await tx.pointLot.createMany({
      data: lots.map((lot) => ({
        id: lot.id,
        entityId: account.entityId,
        kind: lot.kind,
        sourceType: lot.sourceType,
        sourceId: lot.sourceId,
        sourceNo: lot.sourceNo ?? 0,
        subscriptionTermId: lot.subscriptionTermId,
        planId: lot.planId,
        planRevisionId: lot.planRevisionId,
        grantedAt: stamp.occurredAt,
        bizDate: stamp.bizDate,
        expiresAt: lot.expiresAt,
        originalQty: lot.qty,
        availableQty: lot.qty,
        costBasisFen: lot.costBasisFen,
        createdAt,
        updatedAt: createdAt,
      })),
    });
    await reached(deps, "lot.insert");
  }
  if (draft.afterLots) await draft.afterLots(lots.map((lot) => lot.id));

  // 4. 操作行
  await tx.ledgerOperation.create({
    data: {
      id: operationId,
      opKey: draft.opKey,
      opType: draft.opType,
      entityId: account.entityId,
      refType: draft.ref.type,
      refId: draft.ref.id,
      ...stamp,
      planDeltaQty: planDelta,
      addonDeltaQty: addonDelta,
      spendableAfterQty: spendableAfter,
      heldAfterQty: heldAfter,
      ...(title === null ? {} : { titleCode: title.code, titleArgs: title.args }),
      ...actorColumns(draft.ctx.actor),
      requestId: draft.ctx.requestId,
      createdAt,
    },
  });
  await reached(deps, "operation.insert");

  // 5. 已有批次的桶；逐批次的流水（新批次的入账流水也在这一步）
  for (const [id, delta] of perLot) {
    const data = Object.fromEntries(
      Object.entries(delta).map(([column, by]) => [column, { increment: by }]),
    );
    await tx.pointLot.update({ where: { id }, data: { ...data, updatedAt: createdAt } });
  }
  if (perLot.size > 0) await reached(deps, "lot.update");
  const entry = (lot: LotRef, from: Bucket, to: Bucket, qty: number, hold?: string | null) => ({
    id: uuidv7(),
    ledgerOperationId: operationId,
    entityId: account.entityId,
    pointLotId: lot.id,
    pointHoldId: hold ?? null,
    lotKind: lot.kind,
    planId: lot.planId,
    fromBucket: from,
    toBucket: to,
    qty,
    ...stamp,
    createdAt,
  });
  const entries = [
    ...lots.map((lot) => entry(lot, "external", "available", lot.qty)),
    ...moves.map((move) => entry(move.lot, move.from, move.to, move.qty, move.pointHoldId)),
  ];
  if (entries.length > 0) {
    await tx.pointLedgerEntry.createMany({ data: entries });
    await reached(deps, "entry.insert");
  }

  // 7. 账户缓存与 last_op_at
  await tx.billingAccount.update({
    where: { entityId: account.entityId },
    data: {
      planAvailableQty: planAfter,
      addonAvailableQty: addonAfter,
      heldTotalQty: heldAfter,
      ...draft.accountPatch,
      lastOpAt: clock.now,
      updatedAt: clock.now,
    },
  });
  await reached(deps, "account.update");
  Object.assign(account, draft.accountPatch, {
    planAvailableQty: planAfter,
    addonAvailableQty: addonAfter,
    heldTotalQty: heldAfter,
  });

  return {
    id: operationId,
    lotIds: lots.map((lot) => lot.id),
    planDeltaQty: planDelta,
    addonDeltaQty: addonDelta,
    spendableAfterQty: spendableAfter,
    heldAfterQty: heldAfter,
  };
}
