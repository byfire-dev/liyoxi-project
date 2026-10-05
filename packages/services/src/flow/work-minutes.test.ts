import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { createSampleFlow, fixedWorkMinutes, useTestDatabase } from "../testing/index.js";
import type { SampleFlow } from "../testing/index.js";
import {
  changed,
  companionsFor,
  historyOf,
  insertApproval,
  insertStaff,
  opsAudit,
  seedStaffRole,
  SLOW,
  staffContext,
  tally,
} from "./__fixtures__/db.js";
import type { TransitionInput } from "./transition.js";

// 验收第 9 条：elapsed_work_min 只有交付工单、审批单、客服工单写，经“工作分钟”端口按写入时的日历算好固化。
// 端口未注册时这三张表的迁移抛内部错误，不写空值；其余表该列为空。真实实现由 W0-30 接上。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let bare: SampleFlow;
let timed: SampleFlow;

beforeAll(async () => {
  prisma = await db.prisma();
  bare = createSampleFlow(prisma);
  timed = createSampleFlow(prisma, { workMinutes: fixedWorkMinutes });
  await seedStaffRole(prisma);
}, SLOW);

const approval = (id: string, extra: object): TransitionInput =>
  ({
    machine: "approval_request",
    stateField: "status",
    id,
    emit: changed,
    audit: {
      stream: "ops",
      category: "approval",
      action: "lyxtest.approval.transition",
      summary: "样例：审批单迁移",
      target: { type: "approval_request", id },
    },
    ...extra,
  }) as unknown as TransitionInput;

describe("transition：工作分钟（验收 9）", () => {
  it(
    "端口未注册：迁移三张表之一抛内部错误，四处都没有写入",
    async () => {
      const { id, staffId } = await insertApproval(prisma);
      const before = await tally(prisma);
      const error = await bare.tx
        .run((tx) =>
          bare.flow.transition(
            tx,
            staffContext(staffId),
            approval(id, { event: "submit", created: true }),
          ),
        )
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ name: "FlowError", reason: "work_minutes" });
      expect(await tally(prisma)).toEqual(before);
    },
    SLOW,
  );

  it(
    "注册固定日历的样例实现：elapsed_work_min 等于期望值，链的第一行为空",
    async () => {
      const { id, staffId } = await insertApproval(prisma);
      const ctx = staffContext(staffId);
      // 周一 12:00（北京时间）提交
      await timed.tx.run((tx) =>
        timed.flow.transition(tx, ctx, approval(id, { event: "submit", created: true })),
      );
      // 周二 10:00 撤回：自然时间 22 小时；工作时间 = 周一 12:00–18:00 的 360 分钟 + 周二 09:00–10:00 的 60 分钟
      timed.clock.advance(22 * 3_600_000);
      await timed.tx.run((tx) =>
        timed.flow.transition(
          tx,
          ctx,
          approval(id, { event: "withdraw", set: { decided_at: timed.clock.now() } }),
        ),
      );
      const history = await historyOf(prisma, id);
      expect(history.map((row) => [row.toState, row.elapsedSeconds, row.elapsedWorkMin])).toEqual([
        ["pending", null, null],
        ["withdrawn", 79_200, 420],
      ]);
    },
    SLOW,
  );

  it(
    "其余的表该列为空，端口注没注册都一样",
    async () => {
      for (const sample of [bare, timed]) {
        const id = await insertStaff(prisma);
        const step = (event: string, to: string): Promise<unknown> =>
          sample.tx.run((tx) =>
            sample.flow.transition(tx, staffContext(), {
              machine: "staff",
              stateField: "status",
              id,
              event,
              emit: changed,
              audit: opsAudit(id),
              set: companionsFor("staff.status", to, sample.clock.now()),
            }),
          );
        await step("staff.disable", "disabled");
        sample.clock.advance(3_600_000);
        await step("staff.enable", "active");
        const history = await historyOf(prisma, id);
        expect(history.map((row) => [row.elapsedSeconds, row.elapsedWorkMin])).toEqual([
          [null, null],
          [3_600, null],
        ]);
      }
    },
    SLOW,
  );

  it(
    "端口返回的不是非负整数：内部错误，不落库",
    async () => {
      const broken = createSampleFlow(prisma, {
        workMinutes: { between: () => Promise.resolve(1.5) },
      });
      const { id, staffId } = await insertApproval(prisma);
      const ctx = staffContext(staffId);
      await broken.tx.run((tx) =>
        broken.flow.transition(tx, ctx, approval(id, { event: "submit", created: true })),
      );
      const before = await tally(prisma);
      const error = await broken.tx
        .run((tx) =>
          broken.flow.transition(
            tx,
            ctx,
            approval(id, { event: "withdraw", set: { decided_at: broken.clock.now() } }),
          ),
        )
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ name: "FlowError", reason: "work_minutes" });
      expect(await tally(prisma)).toEqual(before);
    },
    SLOW,
  );
});
