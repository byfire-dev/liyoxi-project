// 状态迁移表的声明形态（03 第 3.1 节：迁移表是 packages/shared 里的代码数据；计划 第 5.7 节“状态机”行）。
// 表里只有“状态 × 事件 → 新状态”与有无守卫。守卫与副作用的实现、出站事件名、触发者都不在这里：
// 由拥有状态机的模块按行登记（flow 与各域）。
// 状态取值的类型来自契约的枚举（@liyoxi/contract/enums），写错的取值过不了类型检查；
// 状态机与状态列的名字来自契约的登记（@liyoxi/contract/registry）。

import type { EnumDef } from "@liyoxi/contract/enums";
import type { StateFieldOf, StateMachineName } from "@liyoxi/contract/registry";

/** 新状态写它：这一行不改状态，照常写一行状态历史（from_state = to_state） */
export const SAME = "same";

/** 人工纠偏的事件码：固定这一个，且只有人工纠偏用它（01 分组 第 2.6 节） */
export const ADMIN_FORCE_EVENT = "admin.force";

/** 行尾写它：分组文档这一行的“守卫”一栏是“—” */
export const NO_GUARD = { guard: false } as const;

/** 一行迁移 */
export interface TransitionRow<S extends string = string> {
  /**
   * 分组文档状态机表的那一行，写成“分组:行号”（约定 C81、C84 的写法），如 "02:125"。
   * 文档一行写了几个事件码时拆成几行，ref 相同。个别行指向表后的说明（表外行）。
   */
  readonly ref: string;
  /** 当前状态，任意一个都行；null 是对象新建（状态历史的 from_state 为空） */
  readonly from: readonly S[] | null;
  /** 迁移事件码，即 status_transition.event。与出站事件名是两套名字（x01 第 2.1 节 N4） */
  readonly event: string;
  /** 新状态的候选：多于一个时由调用方给出目标。SAME 是不改状态 */
  readonly to: readonly S[] | typeof SAME;
  /** 文档这一行写了守卫。通用守卫（如“工单未暂停”）不在此列 */
  readonly guard: boolean;
}

/** 一条链：一张状态机表的一个状态列（status_transition 的 machine + state_field） */
export interface Chain<S extends string = string> {
  /** 状态机，即最终表名 */
  readonly machine: StateMachineName;
  /** 状态列名 */
  readonly stateField: string;
  /** “表.列”：契约里绑定这一列的枚举就是 states 的来源 */
  readonly column: string;
  /** 状态取值，顺序同契约的枚举 */
  readonly states: readonly S[];
  readonly rows: readonly TransitionRow<S>[];
}

/**
 * 声明用的一行：文档引用、当前状态、事件码、新状态，文档没写守卫的行尾加 NO_GUARD。
 * 写成元组是为了一行迁移占一行，对着分组文档的表逐行看。
 */
export type RowInput<S extends string> = readonly [
  ref: string,
  from: readonly S[] | null,
  event: string,
  to: readonly S[] | typeof SAME,
  options?: typeof NO_GUARD,
];

/**
 * 声明一条链。states 传契约里绑定这一列的枚举；rows 里出现枚举之外的状态过不了类型检查。
 * 改这里的行，要在同一个 PR 改分组文档的那一行（pnpm machines:check 逐行对照）。
 */
export function chain<M extends StateMachineName, S extends string>(
  machine: M,
  stateField: StateFieldOf<M>,
  states: EnumDef<S>,
  rows: readonly RowInput<NoInfer<S>>[],
): Chain<S> {
  return {
    machine,
    stateField,
    column: `${machine}.${stateField}`,
    states: states.values,
    rows: rows.map(([ref, from, event, to, options]) => ({
      ref,
      from,
      event,
      to,
      guard: options?.guard ?? true,
    })),
  };
}
