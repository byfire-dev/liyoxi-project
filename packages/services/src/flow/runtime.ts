// flow 的装配入口（W0-16）：api 与 worker 启动时各调一次 createFlow（装配与 createEvents 之后），拿到 transition。
// 构造时对照迁移表校验状态机的登记，写错即抛 FlowError：要用 transition 就绕不开这道校验。
import { STATE_MACHINE_NAMES } from "@liyoxi/contract/registry";

import type { EmitContext, Events } from "../events/index.js";
import type { Assembly, Clock, Tx } from "../kernel/index.js";
import { bindingsOf, workMinutesPort } from "./bindings.js";
import { selectColumns } from "./repo.js";
import { adminTransition, transition } from "./transition.js";
import type {
  AdminStaffReader,
  AdminTransitionInput,
  TransitionInput,
  TransitionResult,
} from "./transition.js";
import type { StaffContext } from "../authz/index.js";

export interface FlowOptions {
  /** 装配结果：状态机的登记与工作分钟端口的实现从这里取 */
  readonly assembly: Pick<Assembly, "port" | "portEntries">;
  /** 业务时钟：状态历史的 occurred_at、业务行的 updated_at 取它 */
  readonly clock: Clock;
  /** 出站事件（createEvents 给的） */
  readonly events: Pick<Events, "emit">;
  readonly adminStaffReader?: AdminStaffReader;
}

export interface Flow {
  /** 在调用方的事务里迁移一次状态：加锁、查迁移表、守卫、改状态、写历史、副作用、写审计、发事件 */
  transition<const N extends string>(
    tx: Tx,
    ctx: EmitContext,
    input: TransitionInput<N>,
  ): Promise<TransitionResult>;
}

/** 原Flow保持普通迁移能力，既有仅transition的测试替身无需伪造强迁方法。 */
export interface AdminFlow extends Flow {
  adminTransition<const N extends string>(
    tx: Tx,
    ctx: EmitContext,
    staff: StaffContext,
    input: AdminTransitionInput<N>,
  ): Promise<TransitionResult>;
}

export function createFlow(options: FlowOptions): AdminFlow {
  const bindings = bindingsOf(options.assembly);
  const workMinutes = options.assembly.port(workMinutesPort);
  // 状态机表各有哪些列（有没有 lock_version、updated_at，随迁列在不在）：第一次迁移时读一遍系统目录，之后用缓存
  let catalog: ReturnType<typeof selectColumns> | undefined;
  const columns = (tx: Tx): ReturnType<typeof selectColumns> =>
    (catalog ??= selectColumns(tx, STATE_MACHINE_NAMES).catch((error: unknown) => {
      catalog = undefined;
      throw error;
    }));
  const fresh = new WeakMap<Tx, Set<string>>();
  const deps = {
    clock: options.clock,
    events: options.events,
    bindings,
    workMinutes,
    columns,
    fresh,
    ...(options.adminStaffReader ? { adminStaffReader: options.adminStaffReader } : {}),
  };
  return {
    transition: (tx, ctx, input) => transition(tx, deps, ctx, input),
    adminTransition: (tx, ctx, staff, input) => adminTransition(tx, deps, ctx, staff, input),
  };
}
