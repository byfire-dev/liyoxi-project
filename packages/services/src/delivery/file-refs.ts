import { AdminFileCreateBodySchema } from "@liyoxi/contract";
import { assertAccess } from "../authz/index.js";
import { AppError, implementKeyed, fileRefTypePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { declareManualProduction, fileCategoryGuardPort } from "../media/index.js";
import type { FileCategoryGuard } from "../media/index.js";
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
    if (t.editorId && t.editorId !== actor.staff.staff.id) throw new AppError("PERMISSION_DENIED");
    if (
      kind === "sample"
        ? t.step !== "sample_making"
        : !["batch_compose", "delivering"].includes(t.step) || !!t.deliveredAt
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
        dramaEpisodeMasterId: p.dramaEpisodeMasterId,
        aiUsage: p.aiUsage,
        forcedByDrama: await dramaUsesAi(tx, t.orderItem.dramaId),
      });
    },
  };
}
export const deliveryFileRefs = [
  implementKeyed(fileCategoryGuardPort, "sample_video", guard("sample")),
  implementKeyed(fileCategoryGuardPort, "final_episode", guard("final")),
  implementKeyed(fileRefTypePort, "sample", {
    roles: {
      main: { categories: ["sample_video"], retentionDays: 30 },
      feedback: { categories: ["ticket_attachment"], retentionDays: 30 },
    },
    readColumns: async (tx) =>
      (await tx.sample.findMany()).flatMap((s) => [
        { fileId: s.fileId, refId: s.id, role: "main" },
        ...s.feedbackFileIds.map((fileId) => ({ fileId, refId: s.id, role: "feedback" })),
      ]),
  }),
  implementKeyed(fileRefTypePort, "episode_output", {
    roles: { main: { categories: ["final_episode", "sample_video"], retentionDays: 30 } },
    readColumns: async (tx) =>
      (await tx.episodeOutput.findMany()).map((e) => ({
        fileId: e.fileId,
        refId: e.id,
        role: "main",
      })),
  }),
  implementKeyed(fileRefTypePort, "delivery_release", {
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
    roles: { cover: { categories: ["poster"], retentionDays: 30 } },
    readColumns: async (tx) =>
      (await tx.publishList.findMany({ where: { coverFileId: { not: null } } })).map((p) => ({
        fileId: p.coverFileId!,
        refId: p.id,
        role: "cover",
      })),
  }),
];
