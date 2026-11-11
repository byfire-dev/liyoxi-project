import type { PrismaClient } from "@liyoxi/db";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { createPublishWorkbenchFixture } from "./publish-workbench.fixture.js";
import { createTimers } from "../timers/index.js";
import { createPublishTakedown } from "../publish/index.js";
import { createTakedownAssembly } from "../ops/index.js";
import { getNotifyPurchaseMode } from "../billing/index.js";
import { notificationFixture } from "./notify-dispatch.js";
export function createTakedownFixture(prisma: PrismaClient) {
  const h = createPublishWorkbenchFixture(prisma);
  const deps = {
    ...h.deps,
    events: h.events,
    timers: createTimers({ assembly: h.assembly }),
    media: h.media,
  };
  const takedown = createPublishTakedown(deps);
  const evidence = async (f: Awaited<ReturnType<typeof h.release>>) =>
    (
      await h.make.fileObject({
        category: "evidence",
        bucket: "asset",
        scopeType: "store",
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        uploadActorType: "staff",
        uploadActorId: f.qc.row.id,
        uploadClient: "admin",
      })
    ).id;
  async function launch(f: Awaited<ReturnType<typeof h.release>>, taskId: string) {
    await h.deps.publish.submitLaunch(f.o.viewer, taskId, {
      linkKind: "collection",
      collectionUrl: `https://example.invalid/takedown/${taskId}`,
      reportedEpisodeCount: 1,
      actualLaunchDate: calendarDate(h.clock.now()),
    });
    const submission = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId },
      include: { approvalRequest: true },
      orderBy: { roundNo: "desc" },
    });
    await h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: submission.roundNo, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await h.checks("launch.verify")),
    });
  }
  return {
    ...h,
    takedown,
    takedownDeps: deps,
    evidence,
    launch,
    createRuntime() {
      const runtime = createTakedownAssembly(h.assembly);
      runtime.attach(takedown);
      return runtime;
    },
    createNotifyFixture() {
      const fixture = notificationFixture(prisma);
      fixture.deps.purchaseMode = getNotifyPurchaseMode;
      return fixture;
    },
    async ready(options: { twoAccounts?: boolean; daysBeforeEnd?: number; live?: boolean } = {}) {
      const f = await h.release(options.twoAccounts ?? false, 1, async (target) => {
        h.clock.set(
          dayRange(
            addDays(
              target.item.usageEndDate.toISOString().slice(0, 10),
              -(options.daysBeforeEnd ?? 10),
            ),
          ).start,
        );
      });
      const tasks = await h.prisma.launchTask.findMany({
        where: { deliveryTicketId: f.id },
        orderBy: { id: "asc" },
      });
      if (options.live) for (const task of tasks) await launch(f, task.id);
      const takedowns = await h.prisma.takedownTask.findMany({
        where: { deliveryTicketId: f.id, status: { not: "void" } },
        orderBy: { id: "asc" },
      });
      return { ...f, tasks, takedowns };
    },
    async checkBody(f: Awaited<ReturnType<typeof h.release>>, taskId: string) {
      const row = await h.prisma.takedownTask.findUniqueOrThrow({ where: { id: taskId } });
      const checklistCode =
        row.basis === "live" ? ("takedown.check" as const) : ("takedown.absence_check" as const);
      return {
        checklistCode,
        ...(await h.checks(checklistCode)),
        evidenceFileIds: [await evidence(f), await evidence(f)],
      };
    },
  };
}
