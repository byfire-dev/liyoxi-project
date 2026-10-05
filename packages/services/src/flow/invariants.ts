// flow.I12 与启动自检（W0-16；01 分组 第 2.6 节“不变量”、第 3.2 节）。
//   flow.I12：同一条链 (machine, subject_id, state_field) 按 seq 相邻两行首尾相接；最后一行的 to_state 等于表里该列的当前值。
//             不成立说明有人绕过 transition() 改了状态。P2，只在 full 运行里查，不自愈。调度与落库在 W0-24，这里只给查询并登记。
//   自检：迁移表登记的状态机与状态列在库里都存在。接到进程启动由 W0-22、W0-23。
import { CHAINS } from "@liyoxi/shared/machines";

import type { InvariantViolation } from "../kernel/index.js";
import { selectChainBreaks, selectColumns } from "./repo.js";
import type { RawReader } from "./repo.js";

/** 每条链至多报多少条：按 seq 最老的在前 */
export const I12_MAX_VIOLATIONS = 500;

interface ChainName {
  readonly machine: string;
  readonly stateField: string;
}

/** 逐条链核对。不给 chains 即迁移表里的全部 */
export async function findI12Violations(
  db: RawReader,
  chains: readonly ChainName[] = CHAINS,
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  for (const { machine, stateField } of chains) {
    const breaks = await selectChainBreaks(db, machine, stateField, I12_MAX_VIOLATIONS);
    for (const found of breaks) {
      violations.push({
        subject: { type: machine, id: found.subjectId },
        ...(found.entityId === null ? {} : { entityId: found.entityId }),
        detail: {
          problem: found.problem,
          stateField,
          seq: found.seq.toString(),
          expected: found.expected,
          actual: found.actual,
        },
      });
    }
  }
  return violations;
}

/** chains 里库里没有的“表.列”；空数组即都在。不给 chains 即迁移表里的全部 */
export async function findMissingStateColumns(
  db: RawReader,
  chains: readonly ChainName[] = CHAINS,
): Promise<string[]> {
  const columns = await selectColumns(db, [...new Set(chains.map((chain) => chain.machine))]);
  return chains
    .filter((chain) => columns.get(chain.machine)?.has(chain.stateField) !== true)
    .map((chain) => `${chain.machine}.${chain.stateField}`)
    .sort();
}

/** 启动自检：有对不上的即抛错 */
export async function assertStateColumns(
  db: RawReader,
  chains?: readonly ChainName[],
): Promise<void> {
  const missing = await findMissingStateColumns(db, chains);
  if (missing.length > 0) {
    throw new Error(`迁移表登记的状态机与状态列在库里对不上：${missing.join("、")}`);
  }
}
