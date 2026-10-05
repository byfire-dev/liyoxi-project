// 查迁移表的纯函数：给 flow.transition() 与测试用。只看表，不读库、不判守卫。

import { ADMIN_FORCE_EVENT, SAME, type Chain, type TransitionRow } from "./define.js";

/** 展开后的一条迁移：一个当前状态（null 是新建）、一个事件码、一个新状态 */
export interface TransitionTriple<S extends string = string> {
  readonly from: S | null;
  readonly event: string;
  readonly to: S;
  /** 来自哪一行 */
  readonly row: TransitionRow<S>;
}

/** 一次迁移不合法的原因 */
export type TransitionRejection =
  /** 这条链上没有这个事件码 */
  | "unknown_event"
  /** 有这个事件码，但当前状态（或“新建”）下不能发生 */
  | "not_from_state"
  /** 新状态有几个候选，调用方没有给出目标 */
  | "target_required"
  /** 给出的目标不在候选之内 */
  | "target_not_allowed";

export type TransitionCheck<S extends string = string> =
  | {
      readonly ok: true;
      /** 迁移后的状态；不改状态的迁移等于当前状态 */
      readonly to: S;
      /** 放行它的行：同一个（当前状态, 事件码, 新状态）可以来自文档的几行 */
      readonly rows: readonly TransitionRow<S>[];
    }
  | {
      readonly ok: false;
      readonly reason: TransitionRejection;
      /** 当前状态与事件码对得上时，可去的新状态；否则为空 */
      readonly candidates: readonly S[];
    };

/** 这一行是不是人工纠偏（事件码 admin.force）。普通迁移放不放行它由 flow 定 */
export function isForcedRow(row: TransitionRow): boolean {
  return row.event === ADMIN_FORCE_EVENT;
}

const matchesFrom = <S extends string>(row: TransitionRow<S>, from: S | null): boolean =>
  from === null ? row.from === null : row.from !== null && row.from.includes(from);

/** 这一行在给定的当前状态下能去的新状态 */
function targetsOf<S extends string>(row: TransitionRow<S>, from: S | null): readonly S[] {
  if (row.to !== SAME) return row.to;
  // 新建的行不会写 SAME：对照脚本与用例都查
  return from === null ? [] : [from];
}

/** 当前状态（null 是新建）与事件码对得上的行 */
export function findTransitions<S extends string>(
  chain: Chain<S>,
  from: S | null,
  event: string,
): readonly TransitionRow<S>[] {
  return chain.rows.filter((row) => row.event === event && matchesFrom(row, from));
}

/**
 * 判定一次迁移合不合法。to 不给时，候选恰好一个就取它，多于一个算不合法（target_required）。
 * 查不到的（当前状态, 事件码）由调用方回 409 STATE_NOT_ALLOWED（约定 C27、C53）。
 */
export function checkTransition<S extends string>(
  chain: Chain<S>,
  input: { readonly from: S | null; readonly event: string; readonly to?: S },
): TransitionCheck<S> {
  const rows = findTransitions(chain, input.from, input.event);
  if (rows.length === 0) {
    const known = chain.rows.some((row) => row.event === input.event);
    return { ok: false, reason: known ? "not_from_state" : "unknown_event", candidates: [] };
  }
  const candidates = [...new Set(rows.flatMap((row) => targetsOf(row, input.from)))];
  const target = input.to ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (target === undefined) return { ok: false, reason: "target_required", candidates };
  const allowing = rows.filter((row) => targetsOf(row, input.from).includes(target));
  if (allowing.length === 0) return { ok: false, reason: "target_not_allowed", candidates };
  return { ok: true, to: target, rows: allowing };
}

/** 把一条链展开成（当前状态, 事件码, 新状态）三元组，按行的先后；同一个三元组来自几行就出现几次 */
export function expandChain<S extends string>(chain: Chain<S>): readonly TransitionTriple<S>[] {
  return chain.rows.flatMap((row) =>
    (row.from ?? [null]).flatMap((from) =>
      targetsOf(row, from).map((to) => ({ from, event: row.event, to, row })),
    ),
  );
}

/** 这条链用到的事件码，去重，按首次出现的先后 */
export function eventsOf(chain: Chain): readonly string[] {
  return [...new Set(chain.rows.map((row) => row.event))];
}

/** 终态：没有任何一行（人工纠偏除外）能把它带到别的状态。不改状态的行不算 */
export function terminalStates<S extends string>(chain: Chain<S>): readonly S[] {
  const leaving = new Set<S>();
  for (const { from, to, row } of expandChain(chain)) {
    if (from !== null && to !== from && !isForcedRow(row)) leaving.add(from);
  }
  return chain.states.filter((state) => !leaving.has(state));
}

/** 新建时可以落在哪些状态（当前状态为 null 的行的新状态）。没有新建行的链返回空 */
export function initialStates<S extends string>(chain: Chain<S>): readonly S[] {
  const targets = new Set(
    expandChain(chain)
      .filter((triple) => triple.from === null)
      .map((triple) => triple.to),
  );
  return chain.states.filter((state) => targets.has(state));
}
