import type { PrismaClient } from "@liyoxi/db";
import {
  chainOf,
  checkTransition,
  eventsOf,
  expandChain,
  initialStates,
  terminalStates,
} from "@liyoxi/shared/machines";
import type { Chain } from "@liyoxi/shared/machines";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { isAppError } from "../kernel/index.js";
import { createSampleFlow, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  changed,
  companionsFor,
  historyOf,
  insertEntity,
  insertStaff,
  opsAudit,
  seedStaffRole,
  SLOW,
  staffContext,
  stateOf,
} from "./__fixtures__/db.js";
import { FlowError } from "./errors.js";
import { findI12Violations } from "./invariants.js";
import type { TransitionInput } from "./transition.js";

// 验收第 7 条（甲类的性质测试；D7 第 10.2 节 P6）：对随机的事件序列，
//   ① 只到达迁移表里声明的状态；② 终态之后不再变化；③ 每次成功的迁移恰一条历史，被拒的不留历史；④ flow.I12 始终 0 违规。
// 每一轮在真库里新建一个对象，把序列逐个发给 flow，与只查迁移表的模型逐步对照。
// 种子与轮次固定，可用环境变量改：
//   LYX_FC_RUNS=2000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/flow/transition.property.test.ts
const RUNS = Number(process.env.LYX_FC_RUNS ?? 200);
const SEED = Number(process.env.LYX_FC_SEED ?? 20261005);

const db = useTestDatabase("services");
let prisma: PrismaClient;
let sample: SampleFlow;
const ctx = staffContext();

beforeAll(async () => {
  prisma = await db.prisma();
  sample = createSampleFlow(prisma);
  await seedStaffRole(prisma);
}, SLOW);

const CHAINS: readonly Chain[] = [
  chainOf("staff", "status"),
  chainOf("entity", "lifecycle"),
  chainOf("entity", "verification_status"),
];

/**
 * 一步。legal 为真时从当前状态下迁移表放行的迁移里按 pick 取一个（没有可走的就退回随机）；
 * 否则事件码与目标都随机（给不给目标、给哪个都随机），多数会被拒。
 */
interface Step {
  readonly legal: boolean;
  readonly pick: number;
  readonly event: string;
  readonly to: string | undefined;
}

const scenario = fc.constantFrom(...CHAINS).chain((chain) =>
  fc.record({
    chain: fc.constant(chain),
    steps: fc.array(
      fc.record({
        legal: fc.boolean(),
        pick: fc.nat(),
        event: fc.constantFrom(...eventsOf(chain)),
        to: fc.option(fc.constantFrom(...chain.states), { nil: undefined }),
      }),
      { maxLength: 8 },
    ),
  }),
);

/** 把一步落成要发的事件码与目标 */
function resolve(
  chain: Chain,
  state: string,
  step: Step,
): { event: string; to: string | undefined } {
  const legal = expandChain(chain).filter((triple) => triple.from === state);
  const chosen = step.legal ? legal[step.pick % Math.max(legal.length, 1)] : undefined;
  return chosen === undefined ? step : { event: chosen.event, to: chosen.to };
}

/** 新建一个对象并返回 id 与它的初始状态。有“新建”行的链经 flow 新建，写下第一行历史 */
async function create(chain: Chain): Promise<{ id: string; state: string; history: number }> {
  const id = chain.machine === "staff" ? await insertStaff(prisma) : await insertEntity(prisma);
  const state = await stateOf(prisma, chain.machine, chain.stateField, id);
  if (!initialStates(chain).includes(state)) return { id, state, history: 0 };
  const event = chain.rows.find((row) => row.from === null && row.to.includes(state))?.event;
  await sample.tx.run((tx) =>
    sample.flow.transition(tx, ctx, {
      ...inputOf(chain, id),
      event: event as string,
      created: true,
    } as TransitionInput),
  );
  return { id, state, history: 1 };
}

const inputOf = (chain: Chain, id: string): object => ({
  machine: chain.machine,
  stateField: chain.stateField,
  id,
  emit: changed,
  ...(chain.machine === "staff" ? { audit: opsAudit(id) } : { entityId: id }),
});

describe("transition：性质（验收 7）", () => {
  it(
    `随机事件序列（种子 ${SEED}，${RUNS} 轮）：只到达声明的状态；终态不再变；成功恰一条历史；flow.I12 0 违规`,
    async () => {
      let applied = 0;
      let rejected = 0;
      await fc.assert(
        fc.asyncProperty(scenario, async ({ chain, steps }) => {
          const subject = await create(chain);
          let { state, history } = subject;
          const terminal = terminalStates(chain);
          for (const step of steps) {
            const before = state;
            const { event, to } = resolve(chain, state, step);
            const expected = checkTransition(chain, { from: state, event, to });
            const outcome = await sample.tx
              .run((tx) =>
                sample.flow.transition(tx, ctx, {
                  ...inputOf(chain, subject.id),
                  event,
                  to,
                  // 文档几行都放行时取第一行：这里只看状态怎么走
                  ref: expected.ok ? expected.rows[0]?.ref : undefined,
                  set: companionsFor(
                    chain.column,
                    expected.ok ? expected.to : state,
                    sample.clock.now(),
                  ),
                } as TransitionInput),
              )
              .catch((reason: unknown) => reason);
            if (expected.ok) {
              expect(outcome).toMatchObject({ from: state, to: expected.to });
              state = expected.to;
              history += 1;
              applied += 1;
            } else if (expected.reason === "target_required") {
              expect(outcome).toBeInstanceOf(FlowError);
              rejected += 1;
            } else {
              expect(isAppError(outcome) && outcome.error).toBe("STATE_NOT_ALLOWED");
              rejected += 1;
            }
            // ① 只到达表里声明的状态：库里的值与只查迁移表的模型一致
            expect(chain.states).toContain(state);
            expect(await stateOf(prisma, chain.machine, chain.stateField, subject.id)).toBe(state);
            // ② 终态之后不再变化
            if (terminal.includes(before)) expect(state).toBe(before);
          }
          // ③ 每次成功的迁移恰一条历史，被拒的不留
          expect(await historyOf(prisma, subject.id, chain.stateField)).toHaveLength(history);
          // ④ 这条链上 flow.I12 始终 0 违规
          expect(await findI12Violations(prisma, [chain])).toEqual([]);
        }),
        { numRuns: RUNS, seed: SEED },
      );
      process.stdout.write(
        `[flow 性质] 种子 ${SEED}，${RUNS} 轮：成功迁移 ${applied} 次，被拒 ${rejected} 次\n`,
      );
      expect(applied).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0);
    },
    SLOW * 3,
  );
});
