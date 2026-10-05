import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { EventEmitError } from "../events/index.js";
import { createSampleFlow, SAMPLE_FLOW_EVENT, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  changed,
  companionsFor,
  insertEntity,
  SLOW,
  staffContext,
  tally,
} from "./__fixtures__/db.js";
import type { TransitionInput } from "./transition.js";

// 验收第 5 条：每次迁移经 events.emit 发事件，载荷带三个迁移键（x01 第 2.3 节 P4）；
// 从属迁移声明不发（第 2.4 节 E2）；既没传事件也没声明不发是内部错误。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let sample: SampleFlow;
const ctx = staffContext();

beforeAll(async () => {
  prisma = await db.prisma();
  sample = createSampleFlow(prisma);
}, SLOW);

const eventsOf = (aggregateId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId }, orderBy: { seq: "asc" } });

const lifecycle = (id: string) =>
  ({ machine: "entity", stateField: "lifecycle", id, entityId: id }) as const;

describe("transition：事件（验收 5）", () => {
  it(
    "载荷带 fromState、toState、transition；新建对象的 fromState 为空；聚合缺省是迁移的对象",
    async () => {
      const id = await insertEntity(prisma);
      const created = await sample.tx.run((tx) =>
        sample.flow.transition(tx, ctx, {
          ...lifecycle(id),
          event: "entity.create",
          created: true,
          emit: changed,
        }),
      );
      const closed = await sample.tx.run((tx) =>
        sample.flow.transition(tx, ctx, {
          ...lifecycle(id),
          event: "entity.close",
          emit: { ...changed, dedupeKey: `lyxtest.flow:${id}:close` },
          set: companionsFor("entity.lifecycle", "closed", sample.clock.now()),
        }),
      );
      const events = await eventsOf(id);
      expect(events.map((event) => event.id)).toEqual([created.eventId, closed.eventId]);
      expect(events.map((event) => event.payload)).toEqual([
        { v: 1, fromState: null, toState: "active", transition: "entity.create" },
        { v: 1, fromState: "active", toState: "closed", transition: "entity.close" },
      ]);
      expect(events[1]).toMatchObject({
        eventType: SAMPLE_FLOW_EVENT,
        aggregateType: "entity",
        aggregateId: id,
        entityId: id,
        actorType: "staff",
        dedupeKey: `lyxtest.flow:${id}:close`,
        occurredAt: sample.clock.now(),
      });
    },
    SLOW,
  );

  it(
    "从属迁移声明不发：outbox_event 0 行，状态历史与审计照写",
    async () => {
      const id = await insertEntity(prisma);
      const before = await tally(prisma);
      const result = await sample.tx.run((tx) =>
        sample.flow.transition(tx, ctx, {
          ...lifecycle(id),
          event: "entity.abandon",
          emit: { none: true, primary: "store.qualification.approved" },
          set: companionsFor("entity.lifecycle", "abandoned", sample.clock.now()),
        }),
      );
      expect(result.eventId).toBeNull();
      expect(await eventsOf(id)).toHaveLength(0);
      expect(await tally(prisma)).toEqual({
        history: before.history + 1,
        audit: before.audit + 1,
        events: before.events,
      });
    },
    SLOW,
  );

  it(
    "既没传事件也没声明不发、声明不发却不写主事件：内部错误，四处都没有写入",
    async () => {
      const id = await insertEntity(prisma);
      const before = await tally(prisma);
      const abandon = {
        ...lifecycle(id),
        event: "entity.abandon",
        set: companionsFor("entity.lifecycle", "abandoned", sample.clock.now()),
      };
      for (const emit of [undefined, { none: true }, { none: true, primary: "" }]) {
        const error = await sample.tx
          .run((tx) =>
            sample.flow.transition(tx, ctx, { ...abandon, emit } as unknown as TransitionInput),
          )
          .catch((reason: unknown) => reason);
        expect(error).toMatchObject({ name: "FlowError", reason: "event_required" });
      }
      expect(await tally(prisma)).toEqual(before);
    },
    SLOW,
  );

  it(
    "事件过不了 emit 的校验（载荷不合 schema）：整次迁移不落库",
    async () => {
      const id = await insertEntity(prisma);
      const before = await tally(prisma);
      const error = await sample.tx
        .run((tx) =>
          sample.flow.transition(tx, ctx, {
            ...lifecycle(id),
            event: "entity.abandon",
            emit: { type: SAMPLE_FLOW_EVENT, payload: { v: 1, extra: true } },
            set: companionsFor("entity.lifecycle", "abandoned", sample.clock.now()),
          }),
        )
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(EventEmitError);
      expect(await tally(prisma)).toEqual(before);
    },
    SLOW,
  );
});
