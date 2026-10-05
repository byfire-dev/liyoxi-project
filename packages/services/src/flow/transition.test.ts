import type { PrismaClient } from "@liyoxi/db";
import { chainOf, expandChain } from "@liyoxi/shared/machines";
import type { Chain, TransitionTriple } from "@liyoxi/shared/machines";
import { beforeAll, describe, expect, it } from "vitest";

import { AppError, KernelViolation, lockRows, uuidv7 } from "../kernel/index.js";
import { createSampleFlow, sampleActivity, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  changed,
  companionsFor,
  historyOf,
  insertEntity,
  insertStaff,
  insertStore,
  opsAudit,
  place,
  seedStaffRole,
  SLOW,
  staffContext,
  stateOf,
  tally,
} from "./__fixtures__/db.js";
import { FlowError } from "./errors.js";
import { chainKey, rowKey } from "./bindings.js";
import type { TransitionInput } from "./transition.js";

// 验收第 1、2、3、8 条：每次迁移恰一条历史；同事务；非法迁移被拒；锁序。
// 用真实的状态机表 staff（没有主体与门店）与 entity（两个状态列，各成一条链）。

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

/** 一次迁移的入参：staff 的都传审计内容，entity 的靠默认描述补 activity 行 */
function inputFor(chain: Chain, id: string, triple: TransitionTriple): TransitionInput {
  return {
    machine: chain.machine,
    stateField: chain.stateField,
    id,
    event: triple.event,
    to: triple.to,
    ref: triple.row.ref,
    emit: changed,
    ...(triple.from === null
      ? { created: true }
      : { set: companionsFor(chain.column, triple.to, sample.clock.now()) }),
    ...(chain.machine === "staff" ? { audit: opsAudit(id) } : { entityId: id }),
  } as TransitionInput;
}

/** 造一个处在 from 状态的对象：新建的行直接按目标状态插入，其余的插入后摆到 from */
async function subjectIn(chain: Chain, triple: TransitionTriple): Promise<string> {
  const id =
    chain.machine === "staff"
      ? await insertStaff(prisma, triple.from === null ? (triple.to as "active") : "active")
      : await insertEntity(prisma);
  if (triple.from !== null) await place(prisma, chain, id, triple.from, sample.clock.now());
  return id;
}

describe("transition：迁移表逐行驱动（验收 1）", () => {
  const cases = CHAINS.flatMap((chain) =>
    expandChain(chain).map((triple) => ({
      name: `${chain.column} ${triple.row.ref} ${triple.from ?? "—"} --${triple.event}--> ${triple.to}`,
      chain,
      triple,
    })),
  );

  it.each(cases)(
    "$name：恰多 1 行历史，各列正确",
    async ({ chain, triple }) => {
      const id = await subjectIn(chain, triple);
      const before = await tally(prisma);
      const result = await sample.tx.run((tx) =>
        sample.flow.transition(tx, ctx, inputFor(chain, id, triple)),
      );
      const after = await tally(prisma);
      expect(after.history - before.history).toBe(1);
      expect(result).toMatchObject({ from: triple.from, to: triple.to, ref: triple.row.ref });
      const history = await historyOf(prisma, id);
      expect(history).toEqual([
        {
          id: result.id,
          stateField: chain.stateField,
          fromState: triple.from,
          toState: triple.to,
          event: triple.event,
          // 可拨时钟的起点是 2026-01-05 12:00（北京时间）
          bizDate: "2026-01-05",
          elapsedSeconds: null,
          elapsedWorkMin: null,
          isForced: false,
          actorType: "staff",
          requestId: "req-flow-0001",
        },
      ]);
      expect(await stateOf(prisma, chain.machine, chain.stateField, id)).toBe(triple.to);
    },
    SLOW,
  );

  it(
    "停留时长：链的第一行为空，其后等于拨动时钟的秒数；同事务连续迁移为 0；业务日按北京时间",
    async () => {
      const id = await insertStaff(prisma, "active");
      const step = (event: string, to: string, extra: object = {}): Promise<unknown> =>
        sample.tx.run((tx) =>
          sample.flow.transition(tx, ctx, {
            machine: "staff",
            stateField: "status",
            id,
            event,
            to,
            emit: changed,
            audit: opsAudit(id),
            ...extra,
          }),
        );
      await step("staff.create", "active", { created: true });
      sample.clock.advance(90_000);
      await step("staff.disable", "disabled", {
        set: companionsFor("staff.status", "disabled", sample.clock.now()),
      });
      // 拨到北京时间次日 00:30（UTC 仍是前一天）：业务日要跟着北京时间走
      const before = sample.clock.now().getTime();
      sample.clock.set(new Date("2026-01-05T16:30:00.000Z"));
      const gap = Math.floor((sample.clock.now().getTime() - before) / 1000);
      await sample.tx.run(async (tx) => {
        const enable = { machine: "staff", stateField: "status", id, emit: changed } as const;
        await sample.flow.transition(tx, ctx, {
          ...enable,
          event: "staff.enable",
          audit: opsAudit(id),
          set: companionsFor("staff.status", "active", sample.clock.now()),
        });
        await sample.flow.transition(tx, ctx, {
          ...enable,
          event: "staff.disable",
          audit: opsAudit(id),
          set: companionsFor("staff.status", "disabled", sample.clock.now()),
        });
      });
      const history = await historyOf(prisma, id);
      expect(history.map((row) => row.elapsedSeconds)).toEqual([null, 90, gap, 0]);
      expect(history.map((row) => row.bizDate)).toEqual([
        "2026-01-05",
        "2026-01-05",
        "2026-01-06",
        "2026-01-06",
      ]);
      expect(history.map((row) => [row.fromState, row.toState])).toEqual([
        [null, "active"],
        ["active", "disabled"],
        ["disabled", "active"],
        ["active", "disabled"],
      ]);
      sample.clock.set(new Date("2026-01-05T04:00:00.000Z"));
    },
    SLOW,
  );

  it(
    "entity 的两个状态列各成一条链：停留时长各算各的，改一列不动另一列",
    async () => {
      const id = await insertEntity(prisma);
      const go = (stateField: "lifecycle" | "verification_status", event: string, extra: object) =>
        sample.tx.run((tx) =>
          sample.flow.transition(tx, ctx, {
            machine: "entity",
            stateField,
            id,
            event,
            emit: changed,
            entityId: id,
            ...extra,
          } as TransitionInput),
        );
      await go("lifecycle", "entity.create", { created: true });
      sample.clock.advance(40_000);
      await go("verification_status", "qualification.submit", {});
      sample.clock.advance(20_000);
      await go("verification_status", "qualification.approve", {
        set: companionsFor("entity.verification_status", "verified", sample.clock.now()),
      });
      sample.clock.advance(5_000);
      await go("lifecycle", "entity.close", {
        set: companionsFor("entity.lifecycle", "closed", sample.clock.now()),
      });
      const lifecycle = await historyOf(prisma, id, "lifecycle");
      const verification = await historyOf(prisma, id, "verification_status");
      expect(lifecycle.map((row) => [row.fromState, row.toState, row.elapsedSeconds])).toEqual([
        [null, "active", null],
        ["active", "closed", 65],
      ]);
      // 这条链没有“新建”的行：第一行的 from_state 不为空，停留时长为空
      expect(verification.map((row) => [row.fromState, row.toState, row.elapsedSeconds])).toEqual([
        ["unsubmitted", "pending", null],
        ["pending", "verified", 20],
      ]);
      const [row] = await prisma.$queryRawUnsafe<Array<{ lockVersion: number; updatedAt: Date }>>(
        `SELECT lock_version AS "lockVersion", updated_at AS "updatedAt" FROM entity WHERE id = $1::uuid`,
        id,
      );
      // 三次改状态各加 1（新建不改业务行）；updated_at 是最后一次迁移的业务时间
      expect(row).toEqual({ lockVersion: 3, updatedAt: sample.clock.now() });
      sample.clock.set(new Date("2026-01-05T04:00:00.000Z"));
    },
    SLOW,
  );
});

describe("transition：同事务（验收 2）", () => {
  const disable = (id: string): TransitionInput => ({
    machine: "staff",
    stateField: "status",
    id,
    event: "staff.disable",
    emit: changed,
    audit: opsAudit(id),
    set: companionsFor("staff.status", "disabled", sample.clock.now()),
  });

  it(
    "发事件之后用例抛错：状态列、历史、审计、事件四处都没有变化",
    async () => {
      const id = await insertStaff(prisma);
      const before = await tally(prisma);
      const boom = new Error("用例在迁移之后失败");
      await expect(
        sample.tx.run(async (tx) => {
          const result = await sample.flow.transition(tx, ctx, disable(id));
          expect(result.eventId).not.toBeNull();
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await tally(prisma)).toEqual(before);
      expect(await stateOf(prisma, "staff", "status", id)).toBe("active");
    },
    SLOW,
  );

  it(
    "成功：状态已改，历史、审计、事件各恰 1 行",
    async () => {
      const id = await insertStaff(prisma);
      const before = await tally(prisma);
      const result = await sample.tx.run((tx) => sample.flow.transition(tx, ctx, disable(id)));
      const after = await tally(prisma);
      expect(after).toEqual({
        history: before.history + 1,
        audit: before.audit + 1,
        events: before.events + 1,
      });
      expect(await stateOf(prisma, "staff", "status", id)).toBe("disabled");
      expect(await prisma.auditLog.count({ where: { id: result.auditId ?? "" } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { id: result.eventId ?? "" } })).toBe(1);
    },
    SLOW,
  );
});

describe("transition：非法迁移被拒（验收 3）", () => {
  /** 被拒之后四处都没有写入，状态也没变 */
  async function refused(id: string, input: TransitionInput, flow = sample.flow): Promise<unknown> {
    const before = await tally(prisma);
    const state = await stateOf(prisma, "staff", "status", id);
    const error = await sample.tx
      .run((tx) => flow.transition(tx, ctx, input))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(await tally(prisma)).toEqual(before);
    expect(await stateOf(prisma, "staff", "status", id)).toBe(state);
    return error;
  }
  const base = (id: string) =>
    ({ machine: "staff", stateField: "status", id, emit: changed, audit: opsAudit(id) }) as const;

  it(
    "迁移表里没有的（状态, 事件）：STATE_NOT_ALLOWED",
    async () => {
      const id = await insertStaff(prisma, "active");
      // active 下没有 staff.enable
      const error = await refused(id, { ...base(id), event: "staff.enable" });
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        error: "STATE_NOT_ALLOWED",
        details: { machine: "staff", state: "active", event: "staff.enable" },
      });
    },
    SLOW,
  );

  it(
    "守卫不满足：STATE_NOT_ALLOWED；守卫抛的领域码原样出去",
    async () => {
      const id = await insertStaff(prisma, "active");
      const set = companionsFor("staff.status", "disabled", sample.clock.now());
      const denied = await refused(id, {
        ...base(id),
        event: "staff.disable",
        set,
        args: { deny: true },
      });
      expect(denied).toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });

      const specific = createSampleFlow(prisma, {
        bindings: {
          [chainKey("staff", "status")]: {
            companions: ["disabled_at", "disabled_reason"],
            guards: {
              [rowKey("03:221", "staff.disable")]: () =>
                Promise.reject(new AppError("PERMISSION_DENIED")),
            },
          },
        },
      });
      const thrown = await refused(id, { ...base(id), event: "staff.disable", set }, specific.flow);
      expect(thrown).toMatchObject({ error: "PERMISSION_DENIED" });
    },
    SLOW,
  );

  it(
    "迁移行标了守卫而没有注册实现：内部错误，不放行",
    async () => {
      const id = await insertStaff(prisma, "active");
      const bare = createSampleFlow(prisma, { bindings: {} });
      const error = await refused(
        id,
        {
          ...base(id),
          event: "staff.disable",
          set: companionsFor("staff.status", "disabled", sample.clock.now()),
        },
        bare.flow,
      );
      expect(error).toBeInstanceOf(FlowError);
      expect(error).toMatchObject({ reason: "guard_missing" });
    },
    SLOW,
  );

  it(
    "代码缺陷类的入参：事件码不在链上、人工纠偏、随迁列没登记、载荷不是对象；对象不存在是 NOT_FOUND",
    async () => {
      const id = await insertStaff(prisma, "pending");
      const reasonOf = async (input: { event: string; set?: object; payload?: unknown }) => {
        const error = await refused(id, { ...base(id), ...input } as unknown as TransitionInput);
        return error instanceof FlowError ? error.reason : error;
      };
      expect(await reasonOf({ event: "staff.promote" })).toBe("unknown_event");
      expect(await reasonOf({ event: "admin.force" })).toBe("unknown_event");
      expect(await reasonOf({ event: "staff.enable", set: { name: "改名" } })).toBe("column");
      expect(await reasonOf({ event: "staff.enable", payload: [1] })).toBe("payload");
      const nobody = uuidv7();
      const missing = await sample.tx
        .run((tx) => sample.flow.transition(tx, ctx, { ...base(nobody), event: "staff.enable" }))
        .catch((reason: unknown) => reason);
      expect(missing).toMatchObject({ error: "NOT_FOUND" });
    },
    SLOW,
  );

  it(
    "新状态有几个候选：不给目标是内部错误，给了就按给的走",
    async () => {
      const id = await insertEntity(prisma);
      await place(
        prisma,
        chainOf("entity", "verification_status"),
        id,
        "pending",
        sample.clock.now(),
      );
      const withdraw = {
        machine: "entity",
        stateField: "verification_status",
        id,
        event: "qualification.withdraw",
        emit: changed,
        entityId: id,
      } as const;
      const error = await sample.tx
        .run((tx) => sample.flow.transition(tx, ctx, withdraw))
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ reason: "ambiguous" });
      const result = await sample.tx.run((tx) =>
        sample.flow.transition(tx, ctx, { ...withdraw, to: "rejected" }),
      );
      expect(result).toMatchObject({ from: "pending", to: "rejected", ref: "02:543" });
    },
    SLOW,
  );

  it(
    "同一组（当前状态, 事件码, 新状态）来自几行文档：要给 ref，守卫与副作用按那一行取；没有 lock_version 的表照样迁移",
    async () => {
      const entityId = await insertEntity(prisma);
      const storeId = await insertStore(prisma, entityId);
      const effects: string[] = [];
      const withStore = createSampleFlow(prisma, {
        bindings: {
          [chainKey("store", "lifecycle")]: {
            companions: ["archived_at", "archive_reason", "archive_actor_type"],
            activity: sampleActivity,
            effects: {
              [rowKey("02:610", "store.archive_by_entity")]: async (_tx, facts) => {
                effects.push(`02:610 ${facts.from}→${facts.to}`);
              },
              [rowKey("02:611", "store.archive_by_entity")]: async (_tx, facts) => {
                effects.push(`02:611 ${facts.from}→${facts.to}`);
              },
            },
          },
        },
      });
      const archive = {
        machine: "store",
        stateField: "lifecycle",
        id: storeId,
        event: "store.archive_by_entity",
        emit: { none: true, primary: "entity.closed" },
        entityId,
        storeId,
        set: {
          archived_at: sample.clock.now(),
          archive_reason: "entity_closed",
          archive_actor_type: "system",
        },
      } as const;
      const noRef = await withStore.tx
        .run((tx) => withStore.flow.transition(tx, ctx, archive))
        .catch((reason: unknown) => reason);
      expect(noRef).toMatchObject({ reason: "ambiguous" });
      const wrongRef = await withStore.tx
        .run((tx) => withStore.flow.transition(tx, ctx, { ...archive, ref: "02:608" }))
        .catch((reason: unknown) => reason);
      expect(wrongRef).toMatchObject({ reason: "ambiguous" });
      expect(effects).toEqual([]);
      const result = await withStore.tx.run((tx) =>
        withStore.flow.transition(tx, ctx, { ...archive, ref: "02:611" }),
      );
      expect(result).toMatchObject({ from: "active", to: "archived", ref: "02:611" });
      expect(effects).toEqual(["02:611 active→archived"]);
      expect(await stateOf(prisma, "store", "lifecycle", storeId)).toBe("archived");
    },
    SLOW,
  );

  it(
    "新建：初始状态要在迁移表里；同一对象不能新建两次",
    async () => {
      const id = await insertStaff(prisma, "pending");
      const create = { ...base(id), event: "staff.create", created: true } as const;
      // staff.bootstrap 只能落在 active，业务行是 pending
      const wrong = await refused(id, { ...create, event: "staff.bootstrap" });
      expect(wrong).toMatchObject({ error: "STATE_NOT_ALLOWED" });
      await sample.tx.run((tx) => sample.flow.transition(tx, ctx, create));
      const twice = await refused(id, create);
      expect(twice).toMatchObject({ reason: "created" });
    },
    SLOW,
  );
});

describe("transition：锁序（验收 8）", () => {
  it(
    "先锁次序靠后的表、再迁移次序靠前的对象：触发锁序断言",
    async () => {
      const entityId = await insertEntity(prisma);
      const staffId = await insertStaff(prisma);
      const error = await sample.tx
        .run(async (tx) => {
          await lockRows(tx, "entity", [entityId]); // entity 的次序在 staff 之后
          await sample.flow.transition(tx, ctx, {
            machine: "staff",
            stateField: "status",
            id: staffId,
            event: "staff.disable",
            emit: changed,
            audit: opsAudit(staffId),
            set: companionsFor("staff.status", "disabled", sample.clock.now()),
          });
        })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(KernelViolation);
      expect(error).toMatchObject({ kind: "lock_order" });
      expect(await stateOf(prisma, "staff", "status", staffId)).toBe("active");
    },
    SLOW,
  );

  it(
    "按次序来（先 staff 后 entity）就过；调用方已经锁过的行再迁移不算违规",
    async () => {
      const entityId = await insertEntity(prisma);
      const staffId = await insertStaff(prisma);
      await sample.tx.run(async (tx) => {
        await lockRows(tx, "staff", [staffId]);
        await lockRows(tx, "entity", [entityId]);
        await sample.flow.transition(tx, ctx, {
          machine: "staff",
          stateField: "status",
          id: staffId,
          event: "staff.disable",
          emit: changed,
          audit: opsAudit(staffId),
          set: companionsFor("staff.status", "disabled", sample.clock.now()),
        });
      });
      expect(await stateOf(prisma, "staff", "status", staffId)).toBe("disabled");
    },
    SLOW,
  );
});

describe("transition：新建的行不进锁序", () => {
  it(
    "先锁了次序靠后的表，再新建次序靠前的对象并接着迁移它：都不撞锁序断言",
    async () => {
      const entityId = await insertEntity(prisma);
      const staffId = await sample.tx.run(async (tx) => {
        await lockRows(tx, "entity", [entityId]);
        const id = await insertStaff(tx, "pending");
        const base = { machine: "staff", stateField: "status", id, emit: changed } as const;
        await sample.flow.transition(tx, ctx, {
          ...base,
          event: "staff.create",
          created: true,
          audit: opsAudit(id),
        });
        await sample.flow.transition(tx, ctx, {
          ...base,
          event: "staff.enable",
          audit: opsAudit(id),
        });
        return id;
      });
      const history = await historyOf(prisma, staffId);
      expect(history.map((row) => [row.fromState, row.toState, row.elapsedSeconds])).toEqual([
        [null, "pending", null],
        ["pending", "active", 0],
      ]);
      // 事务提交之后它就是普通的行：照常加锁，照常过锁序断言
      const error = await sample.tx
        .run(async (tx) => {
          await lockRows(tx, "entity", [entityId]);
          await sample.flow.transition(tx, ctx, {
            machine: "staff",
            stateField: "status",
            id: staffId,
            event: "staff.disable",
            emit: changed,
            audit: opsAudit(staffId),
            set: companionsFor("staff.status", "disabled", sample.clock.now()),
          });
        })
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ kind: "lock_order" });
    },
    SLOW,
  );
});

describe("createFlow：状态机的登记对照迁移表校验", () => {
  it("键不是登记的链、守卫的键不是链上的行、随迁列写了状态列：一次报全", () => {
    const build = (): unknown =>
      createSampleFlow(prisma, {
        bindings: {
          "staff.phase": {},
          [chainKey("staff", "status")]: {
            guards: { [rowKey("03:999", "staff.disable")]: () => Promise.resolve(true) },
            companions: ["status", "Bad-Name"],
          },
        },
      });
    expect(build).toThrow(FlowError);
    expect(build).toThrow(/4 处不对/);
  });
});
