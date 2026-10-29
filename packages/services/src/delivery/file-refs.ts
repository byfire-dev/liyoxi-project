import { AdminFileCreateBodySchema } from "@liyoxi/contract";
import { assertAccess } from "../authz/index.js";
import { AppError, implementKeyed, fileRefTypePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { declareManualProduction, fileCategoryGuardPort } from "../media/index.js";
import type { ClockBoundFileRefType, FileCategoryGuard } from "../media/index.js";
import { manualProductionContext } from "./production-context.js";
import { boundDelivery } from "./binding.js";
import { ticketOf } from "./repo.js";
import { invalid, unpaused, dramaUsesAi } from "./quality.js";
function guard(kind: "sample" | "final"): FileCategoryGuard {
  const context = async (
    tx: Tx,
    actor: Parameters<FileCategoryGuard["assert"]>[1],
    input: Parameters<FileCategoryGuard["assert"]>[2],
  ) => {
    if (!actor.staff || actor.identity.actor.type !== "staff")
      throw new AppError("PERMISSION_DENIED");
    assertAccess(actor.staff, {
      module: { module: "delivery", need: "edit" },
      permission: kind === "sample" ? "delivery.sample.upload" : "delivery.episode.register",
    });
    const p = AdminFileCreateBodySchema.shape.production.parse(input.production);
    if (!p || p.kind !== kind || !p.orderItemId || !p.episodeNo)
      throw invalid("production", "必须声明本订单项、种类和集号");
    const row = await tx.deliveryTicket.findUnique({ where: { orderItemId: p.orderItemId } });
    if (!row) throw new AppError("NOT_FOUND");
    const t = await ticketOf(
      tx,
      row.id,
      actor.staff.moduleLevels.delivery === "o"
        ? { ...actor.staff, moduleLevels: { ...actor.staff.moduleLevels, delivery: "v" } }
        : actor.staff,
    );
    unpaused(t);
    if (input.storeId !== t.storeId) throw new AppError("NOT_FOUND");
    if (
      t.editorId &&
      t.editorId !== actor.staff.staff.id &&
      !actor.staff.staff.isLead &&
      actor.staff.staff.roleKey !== "super_admin"
    )
      throw new AppError("PERMISSION_DENIED");
    const reissue =
      kind === "final" && ["awaiting_launch", "launch_verify", "in_service"].includes(t.step)
        ? await tx.deliveryReissue.findFirst({
            where: { deliveryTicketId: t.id, status: "open", episodeNos: { has: p.episodeNo } },
          })
        : null;
    if (
      kind === "sample"
        ? t.step !== "sample_making"
        : !reissue && (!["batch_compose", "delivering"].includes(t.step) || !!t.deliveredAt)
    )
      throw new AppError("STATE_NOT_ALLOWED");
    if (p.episodeNo > t.orderItem.episodeCount || (kind === "sample" && p.episodeNo !== 1))
      throw invalid("production.episodeNo", "制作集号越界");
    if (p.dramaEpisodeMasterId) {
      const m = await tx.dramaEpisodeMaster.findUnique({ where: { id: p.dramaEpisodeMasterId } });
      if (!m || m.dramaId !== t.dramaId || m.episodeNo !== p.episodeNo)
        throw invalid("production.dramaEpisodeMasterId", "原片不属于本剧本集");
    }
    return { p, t, staff: actor.staff };
  };
  return {
    assert: async (tx, a, i) => {
      await context(tx, a, i);
    },
    registered: async (tx, fileId, a, i) => {
      const { p, t, staff } = await context(tx, a, i);
      await declareManualProduction(tx, boundDelivery().clock, {
        fileId,
        kind,
        orderItemId: t.orderItemId,
        episodeNo: p.episodeNo!,
        entityId: t.entityId,
        storeId: t.storeId,
        productionTier: t.orderItem.productionModel,
        uploadedByStaffId: staff.staff.id,
        ...(await manualProductionContext(
          tx,
          t,
          staff.staff.id,
          p.episodeNo!,
          p.dramaEpisodeMasterId,
        )),
        aiUsage: p.aiUsage,
        forcedByDrama: await dramaUsesAi(tx, t.orderItem.dramaId),
      });
    },
  };
}
const sampleRef: ClockBoundFileRefType = {
  async inUse() {
    throw new TypeError("样片意见证据在用事实须绑定 media 业务时钟");
  },
  withClock(clock) {
    return {
      ...this,
      async inUse(tx, fileId) {
        const cutoff = new Date(clock.now().getTime()),
          month = cutoff.getUTCMonth();
        cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
        if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
        return (
          await tx.sample.findMany({
            where: { OR: [{ fileId }, { feedbackFileIds: { has: fileId } }] },
            select: {
              id: true,
              fileId: true,
              status: true,
              feedbackFileIds: true,
              deliveryTicket: { select: { archivedAt: true, terminatedAt: true } },
            },
          })
        ).flatMap((row) => {
          const endedAt = row.deliveryTicket.archivedAt ?? row.deliveryTicket.terminatedAt;
          return [
            ...(row.fileId === fileId &&
            endedAt === null &&
            !["superseded", "qc_rejected", "check_rejected"].includes(row.status)
              ? [{ fileId, refId: row.id, role: "main" }]
              : []),
            // 修改意见是独立证据，不随样片被取代而释放；关联工单关闭后保留三年。
            ...(row.feedbackFileIds.includes(fileId) && (endedAt === null || endedAt > cutoff)
              ? [{ fileId, refId: row.id, role: "feedback" }]
              : []),
          ];
        });
      },
    };
  },
  roles: {
    main: { categories: ["sample_video"], retentionDays: 30 },
    feedback: { categories: ["ticket_attachment"], retentionDays: 30 },
  },
  readColumns: async (tx) =>
    (await tx.sample.findMany()).flatMap((s) => [
      { fileId: s.fileId, refId: s.id, role: "main" },
      ...s.feedbackFileIds.map((fileId) => ({ fileId, refId: s.id, role: "feedback" })),
    ]),
};
export const deliveryFileRefs = [
  implementKeyed(fileCategoryGuardPort, "sample_video", guard("sample")),
  implementKeyed(fileCategoryGuardPort, "final_episode", guard("final")),
  implementKeyed(fileRefTypePort, "sample", sampleRef),
  implementKeyed(fileRefTypePort, "episode_output", {
    inUse: async (tx, fileId) =>
      (
        await tx.episodeOutput.findMany({
          where: {
            fileId,
            status: { notIn: ["replaced", "qc_rejected", "check_rejected"] },
            deliveryTicket: { step: { notIn: ["archived", "terminated"] } },
          },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "main" })),
    roles: { main: { categories: ["final_episode", "sample_video"], retentionDays: 30 } },
    readColumns: async (tx) =>
      (await tx.episodeOutput.findMany()).map((e) => ({
        fileId: e.fileId,
        refId: e.id,
        role: "main",
      })),
  }),
  implementKeyed(fileRefTypePort, "delivery_release", {
    inUse: async (tx, fileId) =>
      (
        await tx.deliveryRelease.findMany({
          where: {
            state: "pushed",
            closedAt: null,
            supersededAt: null,
            manifestSnapshot: { array_contains: [{ fileId }] },
          },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "ep" })),
    roles: { ep: { categories: ["final_episode", "sample_video"], retentionDays: 30 } },
    readColumns: async (tx) =>
      (await tx.deliveryRelease.findMany()).flatMap((r) =>
        (r.manifestSnapshot as Array<{ fileId: string }>).map((e) => ({
          fileId: e.fileId,
          refId: r.id,
          role: "ep",
        })),
      ),
  }),
  implementKeyed(fileRefTypePort, "publish_list", {
    inUse: async (tx, fileId) =>
      (
        await tx.publishList.findMany({
          where: {
            coverFileId: fileId,
            deliveryTicket: { step: { notIn: ["archived", "terminated"] } },
          },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "cover" })),
    roles: { cover: { categories: ["poster"], retentionDays: 30 } },
    readColumns: async (tx) =>
      (await tx.publishList.findMany({ where: { coverFileId: { not: null } } })).map((p) => ({
        fileId: p.coverFileId!,
        refId: p.id,
        role: "cover",
      })),
  }),
];
