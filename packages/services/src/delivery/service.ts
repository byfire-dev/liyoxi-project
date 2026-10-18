import type {
  PlanDraftReplaceBody,
  PlanPushBody,
  PlanChangeRequestBody,
  TicketFilter,
  TicketListQuery,
  SampleCreateBody,
  SampleInspectBody,
  SamplePushBody,
  EpisodeRegisterBody,
  InspectEpisodesBody,
  PushPackageBody,
} from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { assertAccess, assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryDeps, DeliveryViewer, DeliveryWriteOptions } from "./context.js";
import { assignManager } from "./assign.js";
import { assertOwner, dateOf, iso, planOf, ticketOf, ticketInclude, ticketScope } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { confirmPlan, pushPlan, replaceDraft, requestPlanChange } from "./plans.js";
import {
  adminPlanView,
  merchantPlanView,
  signPlan,
  ticketCard,
  ticketDetail,
  urgency,
  qcView,
} from "./views.js";
import { createSample, inspectSample, pushSample, confirmSample, sampleOf } from "./samples.js";
import {
  adminSampleView,
  merchantSampleView,
  signMerchantSample,
  signAdminSample,
} from "./sample-views.js";
import {
  registerEpisodes,
  inspectEpisodes,
  inspectPackage,
  episodeView,
  episodeGrid,
} from "./episodes.js";
import { pushPackage } from "./packages.js";
import { AppError, uuidv7 } from "../kernel/index.js";
const steps = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
  "awaiting_launch",
  "launch_verify",
  "in_service",
  "takedown",
];
const view = (staff: StaffContext) =>
  assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
const title = (t: TicketRow) => (t.orderItem.dramaSnapshot as { title?: string }).title ?? "";
const processing = (t: TicketRow) => !["in_service", "archived", "terminated"].includes(t.step);
function inTab(t: TicketRow, tab: string, now: Date) {
  return (
    tab === "all" ||
    (tab === "processing"
      ? processing(t)
      : tab === "closed"
        ? ["archived", "terminated"].includes(t.step)
        : tab === "delivered_today"
          ? !!t.deliveredAt && calendarDate(t.deliveredAt) === calendarDate(now)
          : t.step === tab)
  );
}
export function createDelivery(deps: DeliveryDeps) {
  async function filtered(tx: Tx, staff: StaffContext, q: TicketFilter) {
    const rows = await tx.deliveryTicket.findMany({
        where: ticketScope(staff),
        include: ticketInclude,
      }),
      now = deps.clock.now();
    const stuck =
      q.isStuck === undefined
        ? null
        : new Set(
            (
              await tx.invariantViolation.findMany({
                where: {
                  code: "flow.STUCK_TICKET",
                  subjectType: "delivery_ticket",
                  resolvedAt: null,
                },
                select: { subjectId: true },
              })
            ).map((r) => r.subjectId),
          );
    const sampleQc = new Set<string>();
    if (q.todo === "sample_qc") {
      const samples = await tx.sample.findMany({
        where: { status: "uploaded", deliveryTicketId: { in: rows.map((r) => r.id) } },
        select: { deliveryTicketId: true, fileId: true },
      });
      const ready = new Set(
        (
          await tx.productionRecord.findMany({
            where: { fileId: { in: samples.map((r) => r.fileId) }, pipelineState: "ready" },
            select: { fileId: true },
          })
        ).map((r) => r.fileId),
      );
      for (const sample of samples)
        if (ready.has(sample.fileId)) sampleQc.add(sample.deliveryTicketId);
    }
    return rows.filter(
      (t) =>
        (!q.q ||
          [t.ticketNo, t.store.name ?? "", title(t)].some((s) =>
            s.toLowerCase().includes(q.q!.toLowerCase()),
          )) &&
        (!q.deliveryManagerId ||
          t.deliveryManagerId === (q.deliveryManagerId === "none" ? null : q.deliveryManagerId)) &&
        (!q.editorId || t.editorId === q.editorId) &&
        (!q.publisherId || t.publisherId === q.publisherId) &&
        (!q.productionModel || t.orderItem.productionModel === q.productionModel) &&
        (!q.platform || t.orderItem.orderItemAccounts.some((a) => a.platform === q.platform)) &&
        (!q.overdueOnly || urgency(t, now) === "overdue") &&
        (!q.storeId || t.storeId === q.storeId) &&
        (!q.entityId || t.entityId === q.entityId) &&
        (!q.orderId || t.dramaOrderId === q.orderId) &&
        (!q.agreedLaunchFrom ||
          (!!t.orderItem.agreedLaunchDate &&
            dateOf(t.orderItem.agreedLaunchDate)! >= q.agreedLaunchFrom)) &&
        (!q.agreedLaunchTo ||
          (!!t.orderItem.agreedLaunchDate &&
            dateOf(t.orderItem.agreedLaunchDate)! <= q.agreedLaunchTo)) &&
        (q.isPaused === undefined || t.pauseCount > 0 === q.isPaused) &&
        (!q.pausedBefore || (!!t.pausedAt && t.pausedAt < new Date(q.pausedBefore))) &&
        (q.isStuck === undefined || stuck!.has(t.id) === q.isStuck) &&
        (!q.todo ||
          (q.todo === "staff_assign"
            ? (["ad_prep", "sample_making"].includes(t.step) && t.editorId === null) ||
              (t.step === "delivering" && t.publisherId === null)
            : q.todo === "plan_push"
              ? t.step === "plan_confirm" && t.waitingOn === "staff"
              : t.step === "sample_making" && t.pauseCount === 0 && sampleQc.has(t.id))),
    );
  }
  return {
    sampleCreate: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: SampleCreateBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.sample.upload", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        const sampleId = await createSample(tx, deps, ctx, staff, id, body),
          { s, t } = await sampleOf(tx, sampleId, staff);
        return adminSampleView(tx, deps, t, s, staff);
      }, options);
      return {
        ...(options.idem?.replayed ? data : await signAdminSample(deps, data)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    sampleInspect: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: SampleInspectBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.sample.qc", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        await inspectSample(tx, deps, ctx, staff, id, body);
        const { s, t } = await sampleOf(tx, id, staff);
        return adminSampleView(tx, deps, t, s, staff);
      }, options);
      return {
        ...(options.idem?.replayed ? data : await signAdminSample(deps, data)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    samplePush: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: SamplePushBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.sample.push", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        await pushSample(tx, deps, ctx, staff, id, body);
        const { s, t } = await sampleOf(tx, id, staff);
        return adminSampleView(tx, deps, t, s, staff);
      }, options);
      return {
        ...(options.idem?.replayed ? data : await signAdminSample(deps, data)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    merchantSample: async (viewer: DeliveryViewer, orderItemId: string) => {
      assertOwner(viewer);
      const raw = await deps.tx.run(async (tx) => {
        const t = await tx.deliveryTicket.findFirst({
          where: {
            orderItemId,
            storeId: viewer.membership.storeId,
            entityId: viewer.membership.entityId,
          },
          include: ticketInclude,
        });
        if (!t) throw new AppError("NOT_FOUND");
        const s = await tx.sample.findUnique({
          where: {
            deliveryTicketId_versionNo: {
              deliveryTicketId: t.id,
              versionNo: t.currentSampleVersionNo ?? 0,
            },
          },
        });
        if (!s?.pushedAt) throw new AppError("NOT_FOUND");
        return merchantSampleView(tx, deps, t, s);
      });
      return signMerchantSample(deps, raw);
    },
    sampleConfirm: async (
      viewer: DeliveryViewer,
      id: string,
      body: { versionNo: number; viewedVia: string; hasViewed: boolean },
      options: DeliveryWriteOptions = {},
    ) => {
      assertOwner(viewer);
      const raw = await deps.tx.run(async (tx) => {
        await confirmSample(tx, deps, viewer, id, body);
        const { s, t } = await sampleOf(tx, id, viewer);
        return (await merchantSampleView(tx, deps, t, s)).view;
      }, options);
      return {
        ...(options.idem?.replayed
          ? { ...raw, playable: null }
          : await signMerchantSample(
              deps,
              await deps.tx.run(async (tx) => {
                const { s, t } = await sampleOf(tx, id, viewer);
                return merchantSampleView(tx, deps, t, s);
              }),
            )),
        replayed: options.idem?.replayed ?? false,
      };
    },
    episodes: async (staff: StaffContext, id: string) => {
      view(staff);
      return deps.tx.run(async (tx) => episodeGrid(tx, await ticketOf(tx, id, staff)));
    },
    episodeRegister: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: EpisodeRegisterBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.episode.register", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        const rows = await registerEpisodes(tx, deps, ctx, staff, id, body);
        return { items: await Promise.all(rows.map((e) => episodeView(tx, e))) };
      }, options);
      return { ...data, replayed: options.idem?.replayed ?? false };
    },
    episodeInspect: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: InspectEpisodesBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.episode.qc", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        const results = await inspectEpisodes(tx, deps, ctx, staff, id, body);
        return {
          results,
          ticket: await ticketCard(tx, await ticketOf(tx, id, staff), staff, deps.clock.now()),
        };
      }, options);
      return { ...data, replayed: options.idem?.replayed ?? false };
    },
    packageInspect: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: SampleInspectBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.episode.qc", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        const r = await inspectPackage(tx, deps, ctx, staff, id, body);
        return {
          qcRecord: (await qcView(tx, r))!,
          ticket: await ticketCard(tx, await ticketOf(tx, id, staff), staff, deps.clock.now()),
        };
      }, options);
      // QC 投影在事务内完成，不能把 Promise 存到幂等结果。
      return { ...data, replayed: options.idem?.replayed ?? false };
    },
    packagePush: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: PushPackageBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "publish.package.push", deps.clock.now());
      const data = await deps.tx.run(async (tx) => {
        const result = await pushPackage(
          tx,
          deps,
          ctx,
          staff,
          id,
          body,
          options.idem?.key ?? uuidv7(),
        );
        return {
          ...result,
          ticket: await ticketCard(tx, await ticketOf(tx, id, staff), staff, deps.clock.now()),
        };
      }, options);
      return { ...data, replayed: options.idem?.replayed ?? false };
    },
    list: (staff: StaffContext, q: TicketListQuery) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          rows = (await filtered(tx, staff, q)).filter((t) => inTab(t, q.tab, now));
        const priority = (t: TicketRow) =>
          ({ rush: 0, priority: 1, standard: 2 })[
            t.schedulePriority as "rush" | "priority" | "standard"
          ];
        const sortKey = (t: TicketRow) =>
          q.sort === "-createdAt"
            ? iso(t.createdAt)!
            : q.sort === "agreedLaunchDate"
              ? (dateOf(t.orderItem.agreedLaunchDate) ?? "9999")
              : (iso(t.stepDueAt) ??
                (["awaiting_launch", "launch_verify"].includes(t.step)
                  ? dateOf(t.orderItem.agreedLaunchDate)
                  : null) ??
                "9999");
        rows.sort((a, b) => {
          const byUrgency =
            q.sort === "urgency"
              ? ["overdue", "due_today", "normal"].indexOf(urgency(a, now)) -
                ["overdue", "due_today", "normal"].indexOf(urgency(b, now))
              : 0;
          return (
            byUrgency ||
            (q.sort === "-createdAt" ? -1 : 1) * sortKey(a).localeCompare(sortKey(b)) ||
            (q.sort === "urgency" ? priority(a) - priority(b) : 0) ||
            a.id.localeCompare(b.id)
          );
        });
        return {
          page: q.page,
          pageSize: q.pageSize,
          total: rows.length,
          items: await Promise.all(
            rows
              .slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
              .map((t) => ticketCard(tx, t, staff, now)),
          ),
        };
      });
    },
    summary: (staff: StaffContext, q: TicketFilter) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const rows = await filtered(tx, staff, q),
          now = deps.clock.now();
        return {
          tabs: Object.fromEntries(
            ["processing", ...steps, "closed", "delivered_today", "all"].map((tab) => [
              tab,
              rows.filter((t) => inTab(t, tab, now)).length,
            ]),
          ),
          header: {
            processing: rows.filter(processing).length,
            overdue: rows.filter((t) => urgency(t, now) === "overdue").length,
            dueToday: rows.filter((t) => urgency(t, now) === "due_today").length,
          },
        };
      });
    },
    get: async (staff: StaffContext, id: string) => {
      view(staff);
      const data = await deps.tx.run(async (tx) =>
        ticketDetail(tx, deps, await ticketOf(tx, id, staff), staff, deps.clock.now()),
      );
      return {
        ...data,
        currentSample: data.currentSample ? await signAdminSample(deps, data.currentSample) : null,
      };
    },
    assign: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: { staffId: string; note?: string },
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "merchant.manager.assign", deps.clock.now());
      return deps.tx
        .run(async (tx) => {
          await assignManager(tx, deps, ctx, staff, id, input);
          return ticketDetail(tx, deps, await ticketOf(tx, id, staff), staff, deps.clock.now());
        }, options)
        .then((data) => ({ ...data, replayed: options.idem?.replayed ?? false }));
    },
    adminPlan: (staff: StaffContext, id: string) => {
      view(staff);
      return deps.tx.run(async (tx) => adminPlanView(tx, await planOf(tx, id, staff), staff));
    },
    replaceDraft: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: PlanDraftReplaceBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.plan.edit", deps.clock.now());
      return deps.tx
        .run(async (tx) => {
          await replaceDraft(tx, deps, ctx, staff, id, body);
          return adminPlanView(tx, await planOf(tx, id, staff), staff);
        }, options)
        .then((data) => ({ ...data, replayed: options.idem?.replayed ?? false }));
    },
    push: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: PlanPushBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "delivery.plan.push", deps.clock.now());
      return deps.tx
        .run(async (tx) => {
          await pushPlan(tx, deps, ctx, staff, id, body);
          return adminPlanView(tx, await planOf(tx, id, staff), staff);
        }, options)
        .then((data) => ({ ...data, replayed: options.idem?.replayed ?? false }));
    },
    merchantPlan: async (viewer: DeliveryViewer, id: string) => {
      assertOwner(viewer);
      return signPlan(
        deps,
        await deps.tx.run(async (tx) => merchantPlanView(tx, await planOf(tx, id, viewer))),
      );
    },
    confirm: async (
      viewer: DeliveryViewer,
      id: string,
      body: { versionNo: number },
      options: DeliveryWriteOptions = {},
    ) => {
      assertOwner(viewer);
      const raw = await deps.tx.run(async (tx) => {
        await confirmPlan(tx, deps, viewer, id, body.versionNo);
        return merchantPlanView(tx, await planOf(tx, id, viewer));
      }, options);
      return {
        ...(await signPlan(deps, raw, options.idem?.replayed)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    requestChange: async (
      viewer: DeliveryViewer,
      id: string,
      body: PlanChangeRequestBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertOwner(viewer);
      const raw = await deps.tx.run(async (tx) => {
        await requestPlanChange(tx, deps, viewer, id, body);
        return merchantPlanView(tx, await planOf(tx, id, viewer));
      }, options);
      return {
        ...(await signPlan(deps, raw, options.idem?.replayed)),
        replayed: options.idem?.replayed ?? false,
      };
    },
  };
}
export type Delivery = ReturnType<typeof createDelivery>;
