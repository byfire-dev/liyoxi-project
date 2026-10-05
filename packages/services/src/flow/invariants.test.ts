import { STATE_MACHINE_NAMES } from "@liyoxi/contract/registry";
import type { PrismaClient } from "@liyoxi/db";
import { CHAINS, chainOf } from "@liyoxi/shared/machines";
import { beforeAll, describe, expect, it } from "vitest";

import { uuidv7 } from "../kernel/index.js";
import { createSampleFlow, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  changed,
  companionsFor,
  insertEntity,
  place,
  SLOW,
  staffContext,
} from "./__fixtures__/db.js";
import {
  assertStateColumns,
  findI12Violations,
  findMissingStateColumns,
  I12_MAX_VIOLATIONS,
} from "./invariants.js";

// 验收第 10 条：flow.I12（同一链相邻两行首尾相接；最后一行的 to_state 等于表里该列的当前值）与启动自检。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let sample: SampleFlow;
const ctx = staffContext();
const lifecycle = chainOf("entity", "lifecycle");

beforeAll(async () => {
  prisma = await db.prisma();
  sample = createSampleFlow(prisma);
}, SLOW);

/** 经 flow 新建一个主体并放弃它：两行历史，首尾相接 */
async function abandoned(): Promise<string> {
  const id = await insertEntity(prisma);
  const base = {
    machine: "entity",
    stateField: "lifecycle",
    id,
    entityId: id,
    emit: changed,
  } as const;
  await sample.tx.run(async (tx) => {
    await sample.flow.transition(tx, ctx, { ...base, event: "entity.create", created: true });
    await sample.flow.transition(tx, ctx, {
      ...base,
      event: "entity.abandon",
      set: companionsFor("entity.lifecycle", "abandoned", sample.clock.now()),
    });
  });
  return id;
}

describe("flow.I12（验收 10）", () => {
  it(
    "正常数据 0 条；绕过 transition 直接改一行状态列：报 1 条",
    async () => {
      const kept = await abandoned();
      const bypassed = await abandoned();
      expect(await findI12Violations(prisma)).toEqual([]);

      await place(prisma, lifecycle, bypassed, "closed", sample.clock.now());
      const violations = await findI12Violations(prisma);
      expect(violations).toEqual([
        {
          subject: { type: "entity", id: bypassed },
          entityId: bypassed,
          detail: {
            problem: "state_mismatch",
            stateField: "lifecycle",
            seq: expect.any(String),
            expected: "abandoned",
            actual: "closed",
          },
        },
      ]);
      expect(JSON.stringify(violations)).not.toContain(kept);
      // 摆回去就不报了：不变量只看现状，不自愈、不改历史
      await place(prisma, lifecycle, bypassed, "abandoned", sample.clock.now());
      expect(await findI12Violations(prisma)).toEqual([]);
    },
    SLOW,
  );

  it(
    "相邻两行首尾不相接：报那一行；另一条链不受牵连",
    async () => {
      const id = await abandoned();
      // 造一行接不上的历史：上一行到 abandoned，这一行却从 active 出发
      await prisma.$executeRawUnsafe(
        `INSERT INTO status_transition (id, machine, subject_id, state_field, from_state, to_state, event, actor_type, occurred_at, biz_date)
         VALUES ($1::uuid, 'entity', $2::uuid, 'lifecycle', 'active', 'abandoned', 'entity.abandon', 'system', $3::timestamptz, '2026-01-05')`,
        uuidv7(),
        id,
        sample.clock.now().toISOString(),
      );
      const violations = await findI12Violations(prisma);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        subject: { type: "entity", id },
        detail: { problem: "broken_link", expected: "abandoned", actual: "active" },
      });
      expect(await findI12Violations(prisma, [chainOf("entity", "verification_status")])).toEqual(
        [],
      );
    },
    SLOW,
  );

  it(
    "已在装配里登记：P2、只在 full 运行里查、不自愈，登记的函数在事务里跑得通",
    async () => {
      const registered = sample.assembly.invariant("flow.I12");
      expect(registered).toMatchObject({
        module: "flow",
        severity: "P2",
        modes: ["full"],
        heal: "none",
      });
      const found = await sample.tx.run((tx) => registered?.run?.(tx, {}) ?? Promise.resolve([]));
      expect(found.length).toBeLessThanOrEqual(I12_MAX_VIOLATIONS * CHAINS.length);
    },
    SLOW,
  );
});

describe("启动自检：登记的状态机与状态列在库里都存在（验收 10）", () => {
  it(
    "迁移表里的每条链都对得上；状态机一张不少",
    async () => {
      expect(new Set(CHAINS.map((chain) => chain.machine))).toEqual(new Set(STATE_MACHINE_NAMES));
      expect(await findMissingStateColumns(prisma)).toEqual([]);
      await expect(assertStateColumns(prisma)).resolves.toBeUndefined();
    },
    SLOW,
  );

  it(
    "加一个不存在的列名、一张不存在的表：自检失败并指出是哪一个",
    async () => {
      const extra = [
        ...CHAINS,
        { machine: "staff", stateField: "no_such_column" },
        { machine: "no_such_table", stateField: "status" },
      ];
      expect(await findMissingStateColumns(prisma, extra)).toEqual([
        "no_such_table.status",
        "staff.no_such_column",
      ]);
      await expect(assertStateColumns(prisma, extra)).rejects.toThrow(/staff\.no_such_column/);
    },
    SLOW,
  );
});
