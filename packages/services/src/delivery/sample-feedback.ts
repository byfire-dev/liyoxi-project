import { SampleRequestChangeBodySchema } from "@liyoxi/contract";
import type { SampleRequestChangeBody } from "@liyoxi/contract";
import type { Sample } from "@liyoxi/db";
import { record } from "../audit/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { lockCalendarImport } from "../sla/index.js";
import type { DeliveryDeps, DeliveryViewer } from "./context.js";
import { orderSidePort } from "./ports.js";
import { productionEvidence } from "./production-guard.js";
import { invalid, unpaused } from "./quality.js";
import { lockReevaluationInputs } from "./reevaluate-inputs.js";
import { step } from "./reevaluate.js";
import { assertOwner, lockTickets } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { moveSample, sampleAuditMeta } from "./sample-transitions.js";
import { sampleOf } from "./samples.js";

async function stale(tx: Tx, t: TicketRow): Promise<never> {
  const current = t.currentSampleVersionNo
    ? await tx.sample.findUnique({
        where: {
          deliveryTicketId_versionNo: {
            deliveryTicketId: t.id,
            versionNo: t.currentSampleVersionNo,
          },
        },
        select: { id: true },
      })
    : null;
  throw new AppError("SAMPLE_VERSION_STALE", {
    details: { currentVersionNo: t.currentSampleVersionNo, currentSampleId: current?.id ?? null },
  });
}

async function currentSample(tx: Tx, t: TicketRow, s: Sample) {
  const latest = await tx.sample.findFirst({
    where: { deliveryTicketId: t.id },
    orderBy: { versionNo: "desc" },
    select: { id: true },
  });
  if (latest?.id !== s.id || (s.status === "pushed" && s.versionNo !== t.currentSampleVersionNo))
    await stale(tx, t);
}

export async function requestChange(
  tx: Tx,
  deps: DeliveryDeps,
  viewer: DeliveryViewer,
  id: string,
  body: SampleRequestChangeBody,
): Promise<string> {
  assertOwner(viewer);
  const parsed = SampleRequestChangeBodySchema.safeParse(body);
  if (!parsed.success) throw invalid("body", "仅接受合成修改意见及最多三张不重复截图");
  const b = parsed.data,
    first = await sampleOf(tx, id, viewer),
    verifyInputs = await lockReevaluationInputs(tx, [first.t.id]);
  await lockCalendarImport(tx);
  await lockTickets(tx, [first.t.id]);
  await verifyInputs();
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, viewer);
  unpaused(t);
  await currentSample(tx, t, s);
  if (s.versionNo !== t.currentSampleVersionNo) await stale(tx, t);
  if (s.status !== "pushed" || t.step !== "sample_confirm") throw new AppError("STATE_NOT_ALLOWED");
  if (!s.previewChannels.includes("weapp"))
    throw new AppError("SAMPLE_VIEW_CHANNEL_NOT_OFFERED", {
      details: { previewChannels: s.previewChannels },
    });
  if (!(await deps.samplePlayback?.(t.entityId))) throw new AppError("FEATURE_DISABLED");
  const production = await deps.media.deliveryProductionFacts(tx, s.fileId);
  if (!production.ready || !production.production || !production.playable)
    throw new AppError("SAMPLE_PREVIEW_NOT_READY");
  const fileIds = b.imageFileIds ?? [];
  await lockRows(tx, "file_object", fileIds);
  // media.link revalidates storage/moderation/category; merchant ownership is stricter here.
  for (const fileId of fileIds) {
    const file = await tx.fileObject.findUnique({ where: { id: fileId } });
    if (
      !file ||
      file.scopeType !== "store" ||
      file.entityId !== t.entityId ||
      file.storeId !== t.storeId ||
      file.uploadActorType !== "merchant" ||
      file.uploadActorId !== viewer.ctx.actor.id
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [fileId], reason: "scope_mismatch" },
      });
    await deps.media.link(tx, {
      fileId,
      entityId: t.entityId,
      storeId: t.storeId,
      refType: "sample",
      refId: s.id,
      role: "feedback",
    });
  }
  await moveSample(tx, deps, viewer.ctx, t, s, "sample.change_requested", {
    decided_at: deps.clock.now(),
    decided_by_user_id: viewer.ctx.actor.id,
    decide_client: viewer.ctx.actor.client,
    feedback_kind: b.feedbackKind,
    feedback_note: b.note,
    feedback_file_ids: fileIds,
  });
  await step(tx, deps, viewer.ctx, t, "sample.change_requested", "sample_making", "10:177", {
    sample_round_no: t.sampleRoundNo + 1,
  });
  await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [t.orderItemId] });
  return s.id;
}

export async function markSent(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
): Promise<string> {
  const first = await sampleOf(tx, id, staff),
    verifyInputs = await lockReevaluationInputs(tx, [first.t.id]);
  await lockCalendarImport(tx);
  await lockTickets(tx, [first.t.id]);
  await verifyInputs();
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, staff);
  unpaused(t);
  await currentSample(tx, t, s);
  if (
    !["qc_passed", "pushed"].includes(s.status) ||
    (s.status === "qc_passed" ? t.step !== "sample_making" : t.step !== "sample_confirm")
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await productionEvidence(tx, deps.media, s.fileId, true);
  if (s.offlineSentAt) return s.id;
  const now = deps.clock.now();
  await tx.sample.update({
    where: { id },
    data: { offlineSentAt: now, offlineSentByStaffId: staff.staff.id, updatedAt: now },
  });
  await record(tx, ctx.actor, sampleAuditMeta(ctx), {
    stream: "activity",
    category: "delivery",
    action: "delivery.sample.mark_sent",
    summary: "登记样片已经企业微信发送",
    target: { type: "sample", id },
    entityId: t.entityId,
    storeId: t.storeId,
    before: { offlineSentAt: null, offlineSentByStaffId: null },
    after: { offlineSentAt: now.toISOString(), offlineSentByStaffId: staff.staff.id },
    fields: ["offlineSentAt", "offlineSentByStaffId"],
  });
  return s.id;
}
