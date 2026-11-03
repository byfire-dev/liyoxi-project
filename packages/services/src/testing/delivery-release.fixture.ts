import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { PlanContentInput } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../approval/index.js";
import { createFlow } from "../flow/index.js";
import { readAdminFlowStaff } from "../staff/index.js";
import { bindDelivery, createDeliveryM5 } from "../delivery/index.js";
import { createBizNoIssuer, uuidv7 } from "../kernel/index.js";
import type { Harness } from "./delivery-harness.fixture.js";
import { draft } from "./delivery-harness.fixture.js";
import { productionHarness } from "./delivery-production.fixture.js";
import type { ProductionHarness } from "./delivery-production.fixture.js";

/** Preserve shared fixtures while supplying actual approval withdrawal to lifecycle effects. */
export function m5Harness(prisma: PrismaClient) {
  const h = productionHarness(prisma);
  const flow = createFlow({
    assembly: h.assembly,
    clock: h.clock,
    events: h.events,
    adminStaffReader: readAdminFlowStaff,
  });
  const approval = createApproval({
    assembly: h.assembly,
    clock: h.clock,
    flow,
    events: h.events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const deps = { ...h.deps, flow, approval },
    unbind = bindDelivery(deps);
  return {
    ...h,
    flow,
    approval,
    deps,
    async close() {
      unbind();
      await h.close();
    },
  };
}
export type M5Harness = ReturnType<typeof m5Harness>;

export function m5Service(h: Harness) {
  return createDeliveryM5({
    ...h.deps,
    flow: createFlow({
      assembly: h.assembly,
      clock: h.clock,
      events: h.events,
      adminStaffReader: readAdminFlowStaff,
    }),
  });
}

export type M5Order = Awaited<ReturnType<Harness["order"]>>;
export type M5Staff = Awaited<ReturnType<Harness["staff"]>>;

export async function checks(h: Harness, code: string) {
  const template = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code, status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
      key,
      result: "pass" as const,
    })),
  };
}

export async function prepared<TPlacement extends { ad: { id: string } } = never>(
  h: Harness,
  twoAccounts = false,
  withPlacement?: (o: M5Order, editor: M5Staff) => Promise<TPlacement>,
  episodeCount = 1,
) {
  const poster = await h.make.fileObject();
  const o = await h.order(true, 1, poster.id, episodeCount);
  const editor = await h.staff("editor"),
    qc = await h.staff();
  await h.prisma.drama.update({
    where: { id: o.items[0]!.dramaId },
    data: { synopsis: "补发真实制作链路的虚构短剧简介" },
  });
  const content: PlanContentInput = draft(o),
    placement = await withPlacement?.(o, editor);
  if (placement) content.items[0]!.placements.push({ slot: "opening", adId: placement.ad.id });
  if (twoAccounts) {
    const screenshot = await h.make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: o.entity.id,
      storeId: o.store.id,
      uploadActorType: "merchant",
      uploadActorId: o.user.id,
      uploadClient: "weapp",
    });
    const bound = await h.deps.publish.bind(o.viewer, {
      platform: "wechat_channels",
      accountName: "第二个真实核验号",
      accountUid: `M5${uuidv7()}`,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
    const submission = await h.prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: bound.channelAccountId },
      include: { approvalRequest: true, channelAccount: true },
    });
    await h.deps.publish.approveAccount(qc.ctx, qc.staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: submission.roundNo, accountUid: submission.channelAccount.accountUid },
      accountType: "none",
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      ...(await checks(h, "account.verify")),
    });
    content.items[0]!.channelAccountIds.push(bound.channelAccountId);
  }
  await h.delivery.replaceDraft(qc.ctx, qc.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content,
  });
  await h.delivery.push(qc.ctx, qc.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  await m5Service(h).assignEditor(qc.ctx, qc.staff, o.deliveryTicketIds[0]!, {
    staffId: editor.row.id,
  });
  return {
    o,
    editor,
    qc,
    id: o.deliveryTicketIds[0]!,
    item: o.items[0]!,
    accountIds: content.items[0]!.channelAccountIds,
    placement,
  };
}

/** Only codecs/storage are doubles. Registration, promote, probe and production facts are real. */
export async function productionFile(
  h: ProductionHarness,
  o: M5Order,
  editor: M5Staff,
  category: "sample_video" | "final_episode",
  episodeNo = 1,
) {
  await h.master(o.items[0]!.dramaId, episodeNo, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff },
    bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const result = await h.media.register(actor, {
    category,
    storeId: o.store.id,
    production: {
      kind: category === "sample_video" ? "sample" : "final",
      orderItemId: o.items[0]!.id,
      episodeNo,
      aiUsage: { used: false, tools: [] },
    },
    files: [
      { fileName: `m5-${episodeNo}.mp4`, sizeBytes: String(bytes.length), clientToken: uuidv7() },
    ],
  });
  const file = result.items[0]!;
  h.fake.storage.put({ bucket: "media", key: file.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, file.fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  await h.finish(file.fileId, category === "sample_video");
  return file.fileId;
}

/** Split the same real release producers across sequential bounded test setup hooks. */
export function releaseSteps(
  h: ProductionHarness,
  twoAccounts = false,
  beforePush?: (f: Awaited<ReturnType<typeof prepared>>) => Promise<void>,
  episodeCount = 1,
) {
  let f: Awaited<ReturnType<typeof prepared>>, fileId: string;
  let sample: Awaited<ReturnType<typeof h.delivery.sampleCreate>>;
  const items: Array<{ episodeNo: number; sampleId?: string; fileId?: string }> = [];
  return {
    async prepare() {
      f = await prepared(h, twoAccounts, undefined, episodeCount);
    },
    async sampleFile() {
      fileId = await productionFile(h, f.o, f.editor, "sample_video");
    },
    async confirmSample() {
      sample = await h.delivery.sampleCreate(f.editor.ctx, f.editor.staff, f.id, {
        fileId,
        adSlots: [],
      });
      await h.delivery.sampleInspect(
        f.qc.ctx,
        f.qc.staff,
        sample.sampleId,
        await checks(h, "qc.sample"),
      );
      await h.delivery.samplePush(f.qc.ctx, f.qc.staff, sample.sampleId, {});
      await h.delivery.merchantSample(f.o.viewer, f.item.id);
      await h.delivery.sampleConfirm(f.o.viewer, sample.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: true,
      });
      items.push({ episodeNo: 1, sampleId: sample.sampleId });
    },
    async finalEpisode(episodeNo: number) {
      items.push({
        episodeNo,
        fileId: await productionFile(h, f.o, f.editor, "final_episode", episodeNo),
      });
    },
    async push() {
      const episodes = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
        items,
      });
      const checklist = await checks(h, "qc.episode");
      await h.delivery.episodeInspect(f.qc.ctx, f.qc.staff, f.id, {
        episodeOutputIds: episodes.items.map((e) => e.episodeOutputId),
        checklistVersionNo: checklist.checklistVersionNo,
        defaultResults: checklist.results,
      });
      await h.delivery.packageInspect(f.qc.ctx, f.qc.staff, f.id, await checks(h, "qc.package"));
      await h.prepareLicenseInputs(f.o.items.map((item) => item.id));
      await h.prepareLicenseReady(f.o.items.map((item) => item.id));
      await beforePush?.(f);
      const pushed = await h.delivery.packagePush(f.qc.ctx, f.qc.staff, f.id, {
        precheck: await checks(h, "delivery.precheck"),
      });
      return { ...f, sample, original: episodes.items[0]!, release: pushed.release };
    },
  };
}

export async function released(
  h: ProductionHarness,
  twoAccounts = false,
  beforePush?: (f: Awaited<ReturnType<typeof prepared>>) => Promise<void>,
  episodeCount = 1,
) {
  const steps = releaseSteps(h, twoAccounts, beforePush, episodeCount);
  await steps.prepare();
  await steps.sampleFile();
  await steps.confirmSample();
  for (let episodeNo = 2; episodeNo <= episodeCount; episodeNo++)
    await steps.finalEpisode(episodeNo);
  return steps.push();
}
