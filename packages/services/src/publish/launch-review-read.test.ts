import { afterAll, beforeAll, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { getLaunchReviewSummary } from "./index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it(
  "审核聚合取真实退回/送审状态、排除作废，读取不写业务/历史/事件",
  { timeout: 60000 },
  async () => {
    expect(await h.tx.run((tx) => getLaunchReviewSummary(tx, uuidv7()))).toEqual({
      hasVerifying: false,
      hasNeedFix: false,
    });
    const { viewer } = await h.owner(),
      admin = await h.staff(),
      fixture = await h.tasks(viewer, [
        await h.account(viewer),
        await h.account(viewer, "wechat_channels"),
      ]),
      taskId = fixture.ids[0]!,
      otherId = fixture.ids[1]!;
    const submit = {
      linkKind: "collection" as const,
      collectionUrl: "https://example.invalid/read-review",
      reportedEpisodeCount: 2,
      actualLaunchDate: "2026-01-04",
    };
    await h.publish.submitLaunch(viewer, taskId, submit);
    const round = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId },
    });
    await h.publish.rejectLaunch(admin.ctx, admin.staff, round.id, {
      reasonCodes: ["R06"],
      note: "请补充链接",
    });
    const read = () => h.tx.run((tx) => getLaunchReviewSummary(tx, fixture.item.id));
    expect(await read()).toEqual({ hasVerifying: false, hasNeedFix: true });
    await h.publish.submitLaunch(viewer, otherId, submit);
    expect(await read()).toEqual({ hasVerifying: true, hasNeedFix: true });
    // M5 作废入口尚未交付；仅构造已经存在的合法 void 事实，核只读筛选。
    await h.prisma.launchTask.update({
      where: { id: otherId },
      data: { reviewStatus: "void", voidReason: "account_changed" },
    });
    expect(await read()).toEqual({ hasVerifying: false, hasNeedFix: true });
    await h.prisma.launchTask.update({
      where: { id: taskId },
      data: { reviewStatus: "void", voidReason: "account_changed" },
    });
    const before = {
      tasks: await h.prisma.launchTask.findMany({ where: { orderItemId: fixture.item.id } }),
      audit: await h.prisma.auditLog.count(),
      history: await h.prisma.statusTransition.count(),
      events: await h.prisma.outboxEvent.count(),
    };
    expect(await read()).toEqual({ hasVerifying: false, hasNeedFix: false });
    expect({
      tasks: await h.prisma.launchTask.findMany({ where: { orderItemId: fixture.item.id } }),
      audit: await h.prisma.auditLog.count(),
      history: await h.prisma.statusTransition.count(),
      events: await h.prisma.outboxEvent.count(),
    }).toEqual(before);
  },
);
