import { ChecklistItemsSchema, COMPARE_FIELDS, DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import {
  createDelivery,
  createTickets,
  prepareTicketAssignees,
  createDeliveryDownloads,
} from "../../delivery/index.js";
import { createDocs } from "../../docs/index.js";
import { createIdentity } from "../../identity/index.js";
import { AppError, createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createProfile } from "../../profile/index.js";
import { createPublish } from "../../publish/index.js";
import { loadKeyring } from "../../security/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { sampleStaffContext } from "../approval.js";
import { createFakeWechat } from "../providers/index.js";
import type { AdminLiveFixture } from "./context.js";
import { createHash } from "node:crypto";
import type { Runtime } from "../../runtime.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import { createW120Media, W120PendingSchema } from "./w120-media.js";
/** 不加员工、不改原八条 live 前置；初始订单由工厂，后续所有业务状态经公开 delivery/publish。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const { tx, clock, assembly, flow, events } = runtime;
  const scope = assertDeliveryLiveEnvironment(runtime.env);
  try {
    const [admin, manager] = await tx.run(async (db) =>
      Promise.all([
        db.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
        db.staff.findFirstOrThrow({
          where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
        }),
      ]),
    );
    const staff = await tx.run((db) => sampleStaffContext(db, admin.id));
    const ctx = createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } });
    const tenant = createTenant({ tx, clock, assembly, flow }),
      keyring = loadKeyring(runtime.env),
      wechat = createFakeWechat();
    const profile = createProfile({
      tx,
      clock,
      assembly,
      events,
      tenant,
      approval: runtime.approval,
      media: runtime.media,
      keyring: () => keyring,
      wechat,
      currentOpenid: async () => "w120-fixture-openid",
    });
    const publish = createPublish({ ...runtime, media: runtime.media });
    const delivery = createDelivery({
      ...runtime,
      media: runtime.media,
      profile,
      publish,
      sla: createSla({ clock, assembly }),
    });
    const identity = createIdentity({
      ...runtime,
      tenant,
      docs: createDocs({ tx, clock }),
      keyring: () => keyring,
      wechat,
      appid: "wx0000000000000000",
    });
    await tx.run((db) =>
      db.dictItem.create({
        data: {
          id: uuidv7(),
          dictTypeKey: "custom_focus",
          code: "W120F",
          name: "后台交付演练重点",
          isEnabled: true,
          position: 999,
          ext: {},
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      }),
    );
    if (
      !(await tx.run((db) =>
        db.agreementVersion.findFirst({
          where: { agreementKey: "custom_license", status: "active" },
        }),
      ))
    )
      await make.agreementVersion({ createdByStaffId: admin.id });
    const consents = await tx.run((db) =>
      db.agreementVersion.findMany({
        where: { agreementKey: { in: ["user", "privacy"] }, status: "active" },
      }),
    );
    const checks = async (code: string) => {
      const template = await tx.run((db) =>
        db.checklistTemplate.findFirstOrThrow({ where: { code, status: "active" } }),
      );
      return {
        checklistVersionNo: template.versionNo,
        results: ChecklistItemsSchema.parse(template.items).map((item) => ({
          key: item.key,
          result: "pass" as const,
        })),
      };
    };
    const items = [];
    for (const [index, outcome] of ["pass", "reject"].entries()) {
      const name = `交付核验演练门店${index + 1}`,
        user = await make.merchantUser({ phone: `1880000120${index}` }),
        entity = await make.entity({ createdByUserId: user.id, verificationStatus: "verified" }),
        store = await make.store({
          entityId: entity.id,
          name,
          isPrimary: true,
          qualificationStatus: "verified",
          deliveryManagerId: manager.id,
        }),
        owner = await make.entityMember({
          entityId: entity.id,
          merchantUserId: user.id,
          role: "owner",
          lastStoreId: store.id,
        }),
        term = await make.subscriptionTerm({ entityId: entity.id });
      await make.billingAccount({
        entityId: entity.id,
        subStatus: "active",
        currentSubscriptionTermId: term.id,
      });
      const merchant = { user, entity, store, owner, term },
        code = `w120-${user.id}`;
      wechat.sessions.set(code, { openid: `${code}-openid` });
      wechat.phones.set(code, `1880000120${index}`);
      const login = await identity.phoneLogin(
        {
          requestId: code,
          ip: "127.0.0.1",
          userAgent: "W120 admin live",
          clientVersion: "admin-live-fixtures",
        },
        {
          loginCode: code,
          phoneCode: code,
          consents: consents.map((version) => ({
            agreementKey: version.agreementKey,
            agreementVersionId: version.id,
          })),
        },
      );
      if (login.me.user.merchantUserId !== user.id) throw new Error("W120 商家会话归属不符");
      const viewer = {
        ctx: createIdentityContext({
          actor: {
            type: "merchant" as const,
            id: user.id,
            client: "weapp" as const,
            role: "owner" as const,
          },
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
        }),
        membership: {
          memberId: merchant.owner.id,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          role: "owner" as const,
          storeMode: "active" as const,
        },
      };
      const screenshot = await make.fileObject({
        category: "channel_screenshot",
        bucket: "asset",
        scopeType: "store",
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        uploadActorType: "merchant",
        uploadActorId: user.id,
        uploadClient: "weapp",
      });
      const account = await publish.bind(viewer, {
        platform: "douyin",
        accountName: name,
        accountUid: `W120${index}`,
        accountType: "none",
        screenshotFileIds: [screenshot.id],
      });
      const round = await tx.run((db) =>
        db.channelAccountSubmission.findFirstOrThrow({
          where: { channelAccountId: account.channelAccountId },
          include: { approvalRequest: true },
        }),
      );
      await publish.approveAccount(ctx, staff, round.id, {
        lockVersion: round.approvalRequest.lockVersion,
        confirm: { roundNo: round.roundNo, accountUid: `W120${index}` },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        ...(await checks("account.verify")),
      });
      const order = await make.dramaOrder({
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        placedByUserId: user.id,
        subscriptionTermId: merchant.term.id,
        status: "producing",
        totalChargePoints: 100,
        itemCount: 1,
        focusCodes: ["W120F"],
      });
      const poster = await make.fileObject();
      const drama = await make.drama({
        title: `交付核验演练短剧${index + 1}-${scope.runId}`,
        isAiGenerated: false,
        totalEpisodes: 2,
        dramaClass: "class_1",
        createdByStaffId: admin.id,
        synopsis: "仅用于本轮后台真实流程验收的固定短视频资料",
        posterFileId: poster.id,
      });
      const snapshot = DramaSnapshotSchema.parse({
        dramaId: drama.id,
        title: drama.title,
        totalEpisodes: 2,
        dramaClass: drama.dramaClass,
        genreCodes: drama.genreCodes,
        permits: [],
        licenseEndDate: addDays(calendarDate(clock.now()), 365),
        posterFileId: poster.id,
        allowedPlacements: drama.allowedPlacements,
        isAiGenerated: false,
      });
      const item = await make.orderItem({
        dramaOrderId: order.id,
        dramaId: drama.id,
        phase: "producing",
        episodeCount: 2,
        dramaSnapshot: snapshot,
      });
      const made = await tx.run(async (db) => {
        await prepareTicketAssignees(db, order.id);
        return createTickets(db, { ...runtime, sla: createSla({ clock, assembly }) }, viewer.ctx, {
          dramaOrderId: order.id,
        });
      });
      const ticketId = made.deliveryTicketIds[0];
      if (!ticketId) throw new Error("W120 未创建工单");
      await delivery.replaceDraft(ctx, staff, made.deliveryPlanId, {
        draftLockVersion: 0,
        content: {
          focusCodes: ["W120F"],
          referenceAssetIds: [],
          launchMode: "merchant_self",
          note: "后台交付核验演练",
          items: [
            {
              orderItemId: item.id,
              channelAccountIds: [account.channelAccountId],
              placements: [],
              agreedLaunchDate: addDays(calendarDate(clock.now()), 30),
              expectedDeliveryDate: null,
            },
          ],
        },
      });
      await delivery.push(ctx, staff, made.deliveryPlanId, { draftLockVersion: 1 });
      await delivery.confirm(viewer, made.deliveryPlanId, { versionNo: 1 });
      items.push({
        scope: {
          ...scope,
          startedAt: clock.now().toISOString(),
          entityId: entity.id,
          storeId: store.id,
          orderId: order.id,
          itemId: item.id,
          ticketId,
          dramaId: drama.id,
          uploaderId: admin.id,
          managerId: manager.id,
        },
        name,
        title: drama.title,
        outcome,
        merchantUserId: user.id,
        memberId: owner.id,
        headers: { authorization: `Bearer ${login.token}`, "X-Store-Id": store.id },
      });
    }
    return W120PendingSchema.parse({ items, runId: scope.runId, stage: "awaiting_actual_media" });
  } catch (error) {
    const failure = error as {
      code?: string;
      error?: string;
      meta?: { modelName?: string; constraint?: unknown };
      stack?: string;
      message?: string;
    };
    process.stderr.write(
      `${JSON.stringify({
        fixture: "w120",
        stage: failure.message?.startsWith("W120 physical HTTP") ? failure.message : undefined,
        code: failure.error ?? failure.code,
        model: failure.meta?.modelName,
        constraint: failure.meta?.constraint,
        frames: failure.stack
          ?.split("\n")
          .filter((line) => line.trim().startsWith("at "))
          .slice(0, 3),
      })}\n`,
    );
    throw error;
  }
};
export default fixture;

/** The CLI creates orders/plans only; this phase borrows the one fully configured live Runtime. */
export async function finishW120LiveFixture(
  runtime: Runtime,
  raw: unknown,
  video: { path: string; sha256: string; size: number },
  signal?: AbortSignal,
) {
  const input = W120PendingSchema.parse(raw);
  const { tx, clock, assembly, flow } = runtime;
  signal?.throwIfAborted();
  const media = await createW120Media(runtime, video, input, signal);
  const tenant = createTenant({ tx, clock, assembly, flow });
  const profile = createProfile({
    ...runtime,
    tenant,
    approval: runtime.approval,
    keyring: () => loadKeyring(runtime.env),
    wechat: createFakeWechat(),
    currentOpenid: async () => "w120-fixture-openid",
  });
  const delivery = createDelivery({
    ...runtime,
    profile,
    publish: createPublish(runtime),
    sla: createSla({ clock, assembly }),
  });
  const downloads = createDeliveryDownloads(runtime);
  const checks = async (code: string) => {
    const template = await tx.run((db) =>
      db.checklistTemplate.findFirstOrThrow({ where: { code, status: "active" } }),
    );
    return {
      checklistVersionNo: template.versionNo,
      results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
        key,
        result: "pass" as const,
      })),
    };
  };
  const items = [];
  try {
    for (const pending of input.items) {
      signal?.throwIfAborted();
      const scope = pending.scope,
        ticketId = scope.ticketId,
        item = { id: scope.itemId };
      const staff = await tx.run((db) => sampleStaffContext(db, scope.uploaderId));
      const qc = await tx.run((db) => sampleStaffContext(db, scope.managerId));
      const ctx = createIdentityContext({
        actor: { type: "staff", id: scope.uploaderId, client: "admin" },
      });
      const qcCtx = createIdentityContext({
        actor: { type: "staff", id: scope.managerId, client: "admin" },
      });
      const merchant = { store: { id: scope.storeId } };
      const viewer = {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: pending.merchantUserId, client: "weapp", role: "owner" },
          entityId: scope.entityId,
          storeId: scope.storeId,
        }),
        membership: {
          memberId: pending.memberId,
          entityId: scope.entityId,
          storeId: scope.storeId,
          role: "owner" as const,
          storeMode: "active" as const,
        },
      };
      runtime.logger.info(
        { evt: "w120.actual_media", outcome: pending.outcome, stage: "upload_probe_watermark" },
        "本轮交付夹具开始真实制作",
      );
      const actor = { identity: ctx, staff },
        sampleFile = await media.upload(actor, merchant.store.id, item.id, "sample_video", 1);
      const sample = await delivery.sampleCreate(ctx, staff, ticketId, {
          fileId: sampleFile,
          adSlots: [],
        }),
        sampleChecks = await checks("qc.sample");
      const business = () =>
        tx.run(async (db) => ({
          sample: await db.sample.findUniqueOrThrow({ where: { id: sample.sampleId } }),
          ticket: await db.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
          qc: await db.qcRecord.count({ where: { targetId: sample.sampleId } }),
          history: await db.statusTransition.count({
            where: { subjectId: { in: [ticketId, sample.sampleId] } },
          }),
          audit: await db.auditLog.count({
            where: { targetId: { in: [ticketId, sample.sampleId] } },
          }),
          outbox: await db.outboxEvent.count({
            where: { aggregateId: { in: [ticketId, sample.sampleId] } },
          }),
        }));
      const before = JSON.stringify(await business());
      try {
        await delivery.sampleInspect(qcCtx, qc, sample.sampleId, sampleChecks);
        throw new Error("W120 未知元数据误通过 QC");
      } catch (error) {
        if (!(error instanceof AppError) || error.error !== "PRODUCTION_NOT_READY") throw error;
      }
      if (JSON.stringify(await business()) !== before)
        throw new Error("W120 未知元数据 QC 失败产生业务写入");
      await media.finish(sampleFile, true);
      signal?.throwIfAborted();
      runtime.logger.info(
        { evt: "w120.actual_media", outcome: pending.outcome, stage: "sample_qc" },
        "本轮真实样片已完成制作",
      );
      await delivery.sampleInspect(qcCtx, qc, sample.sampleId, sampleChecks);
      await delivery.samplePush(qcCtx, qc, sample.sampleId, {});
      const signed = await downloads.sampleUrl(viewer, sample.sampleId, {
        requestId: `w120-download:${sample.sampleId}`,
        ip: "127.0.0.1",
        userAgent: "W120 actual download",
        sessionId: null,
        authMethod: null,
      });
      const physical = await fetch(signed.url, { signal }),
        proof = await media.downloadFacts(sampleFile, true);
      const downloaded = new Uint8Array(await physical.arrayBuffer());
      if (
        !physical.ok ||
        downloaded.byteLength !== proof.size ||
        createHash("sha256").update(downloaded).digest("hex") !== proof.sha256
      )
        throw new Error("W120 样片真实下载失败");
      await delivery.sampleConfirm(viewer, sample.sampleId, {
        versionNo: 1,
        viewedVia: "album",
        hasViewed: true,
      });
      const finalFile = await media.upload(actor, merchant.store.id, item.id, "final_episode", 2);
      await media.finish(finalFile);
      const episodes = await delivery.episodeRegister(ctx, staff, ticketId, {
        items: [
          { episodeNo: 1, sampleId: sample.sampleId },
          { episodeNo: 2, fileId: finalFile },
        ],
      });
      const episodeChecks = await checks("qc.episode");
      await delivery.episodeInspect(qcCtx, qc, ticketId, {
        episodeOutputIds: episodes.items.map((episode) => episode.episodeOutputId),
        checklistVersionNo: episodeChecks.checklistVersionNo,
        defaultResults: episodeChecks.results,
      });
      await delivery.packageInspect(qcCtx, qc, ticketId, await checks("qc.package"));
      const ready = await delivery.get(staff, ticketId);
      if (ready.step !== "delivering") throw new Error("W120 公开流程未到待交付");
      runtime.logger.info(
        { evt: "w120.actual_media", outcome: pending.outcome, stage: "delivering" },
        "本轮交付夹具已到待交付",
      );
      items.push({
        name: pending.name,
        title: pending.title,
        outcome: pending.outcome,
        ticketId,
        itemId: item.id,
        sampleId: sample.sampleId,
        mediaFileIds: [sampleFile, finalFile],
      });
    }
    return {
      items,
      mediaFileIds: media.ids(),
      runId: input.runId,
      facts: { sizeBytes: video.size, sha256: video.sha256 },
      unknownMetadataRejectedWithoutWrites: true,
    };
  } catch (error) {
    runtime.logger.error(
      {
        evt: "w120.actual_media.failed",
        error: error instanceof AppError ? error.error : "FIXTURE_PREPARATION_FAILED",
        aborted: signal?.aborted === true,
      },
      "本轮实际制作未完成",
    );
    await media.cleanup();
    throw error;
  }
}
