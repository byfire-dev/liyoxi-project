import { createHash } from "node:crypto";
import { ChecklistItemsSchema, COMPARE_FIELDS, ReleaseManifestItemSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { demoImage } from "../../content/index.js";
import { createDocs } from "../../docs/index.js";
import { createIdentity } from "../../identity/index.js";
import { createIdentityContext, isAppError, lockRows, uuidv7 } from "../../kernel/index.js";
import { createMinioStorage } from "../../providers/index.js";
import {
  createPublish,
  createPublishPatrol,
  createPublishTakedown,
  ensureTakedownTasks,
  launchChangedPort,
  readDeliveryPublishTargets,
} from "../../publish/index.js";
import { loadKeyring } from "../../security/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { sampleStaffContext } from "../approval.js";
import { createFakeWechat } from "../providers/index.js";
import type { AdminLiveFixture } from "./context.js";
import {
  assertDeliveryLiveEnvironment,
  KNOWN_VIDEO,
  knownVideoBytes,
} from "./delivery-known-media.js";

/** W609 的历史已交付输入边界（含真实文件、历史 QC、成片及完整 release manifest）。
 * 不宣称重演付款/制作/推包；账号审核、上线、巡检及下架事实仍只经公开服务。
 * 不写巡检结果、下架终态或商家确认列；不改共享工厂序号和时钟。
 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  let phase = "scope";
  try {
    const scope = assertDeliveryLiveEnvironment(runtime.env);
    if (runtime.providers.storage.status !== "fake") throw new Error("W609 仅接受本轮隔离替身环境");
    const { tx, clock } = runtime,
      today = calendarDate(clock.now()),
      startedAt = clock.now().toISOString();
    phase = "identity_inputs";
    const admin = await tx.run((db) =>
      db.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
    );
    const manager = await make.staff({
      name: `W609交付-${scope.runId}`,
      staffRoleKey: "delivery_manager",
    });
    const publisher = await make.staff({
      name: `W609发布-${scope.runId}`,
      staffRoleKey: "publisher",
    });
    const staff = await tx.run((db) => sampleStaffContext(db, admin.id)),
      ctx = createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } });
    const publish = createPublish(runtime),
      patrol = createPublishPatrol(runtime),
      deps = { ...runtime, sla: createSla(runtime), sampleDraw: () => 1 },
      takedown = createPublishTakedown(deps);
    const user = await make.merchantUser({ phone: "18800006090" }),
      entity = await make.entity({
        name: `W609验收主体-${scope.runId}`,
        createdByUserId: user.id,
        verificationStatus: "verified",
      }),
      store = await make.store({
        entityId: entity.id,
        name: `W609生命周期门店-${scope.runId}`,
        isPrimary: true,
        qualificationStatus: "verified",
        deliveryManagerId: manager.id,
      }),
      member = await make.entityMember({
        entityId: entity.id,
        merchantUserId: user.id,
        role: "owner",
        lastStoreId: store.id,
      });
    await make.billingAccount({ entityId: entity.id });
    const viewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
        entityId: entity.id,
        storeId: store.id,
      }),
      membership: {
        memberId: member.id,
        entityId: entity.id,
        storeId: store.id,
        role: "owner" as const,
        storeMode: "active" as const,
      },
    };
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
    phase = "patrol_issue_create";
    const kind = await runtime.configAdmin.createDictItem(
      { identity: ctx, staff },
      { typeKey: "patrol_issue", name: "W609巡检异常" },
    );
    const historicalAt = new Date(`${addDays(today, -10)}T00:00:00Z`);
    /** Owned historical inputs contain actual local bytes, never dangling fixture keys. */
    async function historicalFile(category: "channel_screenshot" | "final_episode") {
      const body =
          category === "final_episode" ? await knownVideoBytes() : demoImage([80, 130, 170]),
        ext = category === "final_episode" ? "mp4" : "png",
        mime = category === "final_episode" ? "video/mp4" : "image/png",
        bucket = category === "final_episode" ? "media" : "asset",
        id = uuidv7(),
        objectKey = `${category}/${store.id}/w609-${scope.runId}-${id}.${ext}`,
        sha256 = createHash("sha256").update(body).digest("hex"),
        storage = createMinioStorage();
      try {
        const written = await storage.putObject({
          bucket,
          key: objectKey,
          body,
          contentType: mime,
          ifAbsent: true,
          contentIdentity: sha256,
        });
        const read = await storage.readObject({
          bucket,
          key: objectKey,
          maxBytes: body.byteLength,
        });
        if (
          !written.ok ||
          written.value.size !== body.byteLength ||
          !read.ok ||
          read.value.byteLength !== body.byteLength ||
          createHash("sha256").update(read.value).digest("hex") !== sha256
        )
          throw new Error("W609 历史输入真实字节证明不符");
        return await make.fileObject({
          id,
          category,
          bucket,
          objectKey,
          ext,
          declaredMime: mime,
          mime,
          declaredSize: body.byteLength,
          sizeBytes: body.byteLength,
          sha256,
          etag: written.value.etag,
          originalName: `W609历史输入.${ext}`,
          scopeType: "store",
          entityId: entity.id,
          storeId: store.id,
          uploadActorType: category === "final_episode" ? "staff" : "merchant",
          uploadActorId: category === "final_episode" ? publisher.id : user.id,
          uploadClient: category === "final_episode" ? "admin" : "weapp",
          storedAt: historicalAt,
          createdAt: historicalAt,
          updatedAt: historicalAt,
        });
      } finally {
        await storage.close();
      }
    }
    async function account(suffix: string, approved = true) {
      phase = "account_file_input";
      const screenshot = await historicalFile("channel_screenshot");
      phase = "account_bind";
      const card = await publish.bind(viewer, {
        platform: "douyin",
        accountName: `W609${suffix}`,
        accountUid: `w609-${uuidv7()}`,
        accountType: "none",
        screenshotFileIds: [screenshot.id],
      });
      const submission = await tx.run((db) =>
        db.channelAccountSubmission.findFirstOrThrow({
          where: { channelAccountId: card.channelAccountId },
          include: { approvalRequest: true, channelAccount: true },
        }),
      );
      if (approved) {
        phase = "account_approve";
        await publish.approveAccount(ctx, staff, submission.id, {
          lockVersion: submission.approvalRequest.lockVersion,
          confirm: {
            roundNo: submission.roundNo,
            accountUid: submission.channelAccount.accountUid,
          },
          accountType: "none",
          certSubjectName: null,
          compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
          ...(await checks("account.verify")),
        });
      }
      return {
        accountId: card.channelAccountId,
        submissionId: submission.id,
        name: `W609${suffix}`,
      };
    }
    async function delivered(suffix: string, overdue: boolean) {
      const a = await account(suffix);
      phase = "historical_delivery_inputs";
      const order = await make.dramaOrder({
        entityId: entity.id,
        storeId: store.id,
        placedByUserId: user.id,
        status: "to_launch",
        itemCount: 1,
      });
      const item = await make.orderItem({
        dramaOrderId: order.id,
        phase: "to_launch",
        episodeCount: 1,
        dramaSnapshot: { title: `W609${suffix}作品` },
        agreedLaunchDate: new Date(`${addDays(today, -10)}T00:00:00Z`),
        usageEndDate: new Date(`${addDays(today, overdue ? -3 : 20)}T00:00:00Z`),
      });
      const ticket = await make.deliveryTicket({
        orderItemId: item.id,
        step: "awaiting_launch",
        deliveredAt: historicalAt,
        deliveryManagerId: manager.id,
        publisherId: publisher.id,
        waitingOn: "merchant",
      });
      phase = "historical_release_input";
      const file = await historicalFile("final_episode"),
        outputId = uuidv7(),
        releaseId = uuidv7(),
        episodeCheck = await checks("qc.episode"),
        precheck = await checks("delivery.precheck");
      // These are explicitly historical inputs, not evidence that this run produced or pushed a package.
      // The page assertions begin at public launch/patrol/takedown writers below.
      await tx.run(async (db) => {
        const qc = await db.qcRecord.create({
          data: {
            id: uuidv7(),
            entityId: entity.id,
            storeId: store.id,
            deliveryTicketId: ticket.id,
            targetType: "episode_output",
            targetId: outputId,
            checklistCode: "qc.episode",
            checklistVersionNo: episodeCheck.checklistVersionNo,
            results: episodeCheck.results,
            verdict: "pass",
            inspectedByStaffId: admin.id,
            inspectedAt: historicalAt,
            createdAt: historicalAt,
          },
        });
        await db.episodeOutput.create({
          data: {
            id: outputId,
            entityId: entity.id,
            storeId: store.id,
            deliveryTicketId: ticket.id,
            episodeNo: 1,
            revisionNo: 1,
            fileId: file.id,
            sizeBytes: file.sizeBytes!,
            durationMs: KNOWN_VIDEO.durationMs,
            source: "manual_upload",
            status: "qc_passed",
            isCurrent: true,
            qcRecordId: qc.id,
            uploadedByStaffId: publisher.id,
            uploadedAt: historicalAt,
            createdAt: historicalAt,
            updatedAt: historicalAt,
          },
        });
        const manifest = [
          ReleaseManifestItemSchema.parse({
            episodeNo: 1,
            outputId,
            fileId: file.id,
            name: `W609${suffix}作品_第01集.mp4`,
            size: file.sizeBytes!.toString(),
            crc64: file.crc64,
          }),
        ];
        if (
          manifest.length !== item.episodeCount ||
          file.entityId !== item.entityId ||
          file.storeId !== item.storeId
        )
          throw new Error("W609 历史 release 输入归属或集数不符");
        await db.deliveryRelease.create({
          data: {
            id: releaseId,
            entityId: entity.id,
            storeId: store.id,
            orderItemId: item.id,
            deliveryTicketId: ticket.id,
            releaseNo: 1,
            kind: "initial",
            state: "pushed",
            episodeCount: item.episodeCount,
            totalBytes: file.sizeBytes!,
            manifestSnapshot: manifest,
            checklistCode: "delivery.precheck",
            checklistVersionNo: precheck.checklistVersionNo,
            precheckResults: precheck.results,
            note: "W609 页面验收的历史已交付输入，未重演生产推包",
            pushedByStaffId: publisher.id,
            pushedAt: historicalAt,
            idempotencyKey: `w609-history-${releaseId}`,
            createdAt: historicalAt,
            updatedAt: historicalAt,
          },
        });
        await lockRows(db, "file_object", [file.id]);
        for (const ref of [
          { refType: "episode_output", refId: outputId, role: "main" },
          { refType: "delivery_release", refId: releaseId, role: "ep" },
        ])
          await runtime.media.link(db, {
            ...ref,
            fileId: file.id,
            entityId: entity.id,
            storeId: store.id,
          });
      });
      await tx.run((db) =>
        db.orderItemAccount.create({
          data: {
            orderItemId: item.id,
            channelAccountId: a.accountId,
            platform: "douyin",
            createdAt: clock.now(),
          },
        }),
      );
      phase = "launch_tasks_create";
      const tasks = await tx.run((db) =>
        publish.createLaunchTasks(db, viewer.ctx, {
          orderItemId: item.id,
          deliveryTicketId: ticket.id,
          channelAccountIds: [a.accountId],
        }),
      );
      return {
        ...a,
        orderId: order.id,
        itemId: item.id,
        ticketId: ticket.id,
        launchTaskId: tasks[0]!,
        title: `W609${suffix}作品`,
      };
    }
    const live = await delivered("巡检", false);
    phase = "launch_submit";
    await publish.submitLaunch(viewer, live.launchTaskId, {
      linkKind: "collection",
      collectionUrl: `https://example.invalid/w609/${live.launchTaskId}`,
      reportedEpisodeCount: 1,
      actualLaunchDate: today,
    });
    const submission = await tx.run((db) =>
      db.launchSubmission.findFirstOrThrow({
        where: { launchTaskId: live.launchTaskId },
        include: { approvalRequest: true },
      }),
    );
    phase = "launch_approve";
    await publish.approveLaunch(ctx, staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: submission.roundNo, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await checks("launch.verify")),
    });
    phase = "patrol_create";
    const patrolTask = await patrol.create(ctx, staff, {
      launchTaskId: live.launchTaskId,
      reason: "W609 真实页面验收",
    });
    const offline = [];
    for (const suffix of ["下架甲", "下架乙", "仍在线"]) {
      const row = await delivered(suffix, true);
      phase = "takedown_ensure";
      await tx.run(async (db) => {
        await runtime.assembly.port(launchChangedPort)(db, {
          orderItemId: row.itemId,
          deliveryTicketId: row.ticketId,
          phase: "prelock",
        });
        await ensureTakedownTasks(
          db,
          deps,
          createIdentityContext({ actor: { type: "system", job: "lyxtest.w609_fixture" } }),
          await readDeliveryPublishTargets(db, [row.itemId]),
          { deliveryTicketId: row.ticketId, now: clock.now() },
        );
      });
      phase = "takedown_lookup";
      const task = await tx.run((db) =>
        db.takedownTask.findFirstOrThrow({
          where: { orderItemId: row.itemId, status: { not: "void" } },
        }),
      );
      if (suffix === "仍在线") {
        phase = "merchant_takedown_confirm";
        await takedown.confirm(viewer, task.id, { method: "not_published" });
      }
      offline.push({ ...row, takedownTaskId: task.id });
    }
    const health = await account("健康账号"),
      pending = await account("原核验待办", false);
    const wechat = createFakeWechat(),
      code = `w609-${scope.runId}`;
    wechat.sessions.set(code, { openid: `${code}-openid` });
    wechat.phones.set(code, "18800006090");
    const identity = createIdentity({
      ...runtime,
      tenant: createTenant(runtime),
      docs: createDocs(runtime),
      keyring: () => loadKeyring(runtime.env),
      wechat,
      appid: "wx0000000000000000",
    });
    const consents = await tx.run((db) =>
      db.agreementVersion.findMany({
        where: { agreementKey: { in: ["user", "privacy"] }, status: "active" },
      }),
    );
    phase = "merchant_login";
    const login = await identity.phoneLogin(
      {
        requestId: code,
        ip: "127.0.0.1",
        userAgent: "W609 isolated admin live",
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
    if (login.me.user.merchantUserId !== user.id) throw new Error("W609 商家会话归属不符");
    phase = "staff_manifest";
    // Only describe rows already created by this fixture, including make.drama's implicit creator.
    // Bare historical dramas have no copyright row, so admin.drama.get intentionally cannot read them.
    const deliveries = [live, ...offline];
    const staffManifest = await tx.run(async (db) => {
      const items = await db.orderItem.findMany({
        where: {
          id: { in: deliveries.map((item) => item.itemId) },
          entityId: entity.id,
          storeId: store.id,
        },
        select: { id: true, drama: { select: { id: true, createdByStaffId: true } } },
      });
      if (items.length !== deliveries.length) throw new Error("W609 员工清单订购项范围不完整");
      const staffIds = [
        manager.id,
        publisher.id,
        ...items.map((item) => item.drama.createdByStaffId),
      ];
      if (new Set(staffIds).size !== staffIds.length)
        throw new Error("W609 员工清单未保留独立创建人");
      const rows = await db.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, name: true, staffRoleKey: true, status: true },
      });
      const actor = (id: string, roleKey: string) => {
        const row = rows.find((person) => person.id === id);
        if (!row || row.staffRoleKey !== roleKey || row.status !== "active")
          throw new Error("W609 员工清单角色或状态不符");
        return { staffId: row.id, name: row.name, roleKey: row.staffRoleKey, status: row.status };
      };
      return {
        manager: actor(manager.id, "delivery_manager"),
        publisher: actor(publisher.id, "publisher"),
        creators: deliveries.map((delivery) => {
          const item = items.find((row) => row.id === delivery.itemId)!;
          return {
            orderItemId: item.id,
            dramaId: item.drama.id,
            staff: actor(item.drama.createdByStaffId, "content_ops"),
          };
        }),
      };
    });
    return {
      scope: { ...scope, startedAt, staffId: admin.id, entityId: entity.id, storeId: store.id },
      runId: scope.runId,
      storeId: store.id,
      staffManifest,
      live: { ...live, patrolTaskId: patrolTask.patrolTask.patrolTaskId },
      offline,
      health,
      pending,
      patrolIssueName: kind.name,
      headers: { authorization: `Bearer ${login.token}`, "X-Store-Id": store.id },
    };
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ evt: "w609.fixture.failed", phase, symbol: isAppError(error) ? error.error : "non_application" })}\n`,
    );
    throw error;
  }
};
export default fixture;
