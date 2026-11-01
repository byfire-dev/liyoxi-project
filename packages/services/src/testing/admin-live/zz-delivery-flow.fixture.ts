import { createHash } from "node:crypto";
import { ChecklistItemsSchema, COMPARE_FIELDS, DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { createDocs } from "../../docs/index.js";
import { createIdentity } from "../../identity/index.js";
import { createIdentityContext, isAppError, uuidv7 } from "../../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../../delivery/index.js";
import { createPublish } from "../../publish/index.js";
import { demoImage } from "../../content/demo-image.js";
import { createMedia } from "../../media/index.js";
import { createMinioStorage } from "../../providers/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import { createSla, workHoursAt } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { createFakeWechat } from "../providers/index.js";
import type { AdminLiveFixture, AdminLiveFixtureContext } from "./context.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

async function prepareW513Poster(runtime: AdminLiveFixtureContext["runtime"], runId: string) {
  if (assertDeliveryLiveEnvironment(runtime.env).runId !== runId)
    throw new Error("W513封面拒绝其他轮次");
  const storage = createMinioStorage(),
    body = demoImage([100, 150, 170]);
  let media: ReturnType<typeof createMedia> | undefined;
  try {
    // The shared fixture runtime uses in-memory providers. This one owned image must survive it.
    media = createMedia({
      tx: runtime.tx,
      clock: runtime.clock,
      events: runtime.events,
      assembly: runtime.assembly,
      storage,
    });
    const file = await media.putSystemFile({
      category: "poster",
      fileName: "w513-poster.png",
      body,
      objectKey: `poster/w513/${runId}.png`,
      entityId: null,
      storeId: null,
    });
    const read = await storage.readObject({
      bucket: "pub",
      key: `poster/w513/${runId}.png`,
      maxBytes: body.byteLength,
    });
    if (
      !read.ok ||
      read.value.byteLength !== body.byteLength ||
      createHash("sha256").update(read.value).digest("hex") !== file.sha256
    )
      throw new Error("W513封面真实存储字节证明不符");
    return { ...file, sizeBytes: body.byteLength, readVerified: true as const };
  } finally {
    try {
      await media?.jobs.shutdown();
    } finally {
      await storage.close();
    }
  }
}

/** 本包独立两集前置；不改旧员工、旧订单搜索范围或旧账号核验队列。 */
export async function prepareDeliveryLiveFixture(
  { runtime, make }: AdminLiveFixtureContext,
  own: { prefix: "制作演练" | "W513工单"; loginPrefix: "w119b" | "w513" } = {
    prefix: "制作演练",
    loginPrefix: "w119b",
  },
) {
  let phase = "scope";
  try {
    const connection = assertDeliveryLiveEnvironment(runtime.env),
      startedAt = runtime.clock.now().toISOString();
    const admin = await runtime.tx.run((tx) =>
      tx.staff.findFirstOrThrow({
        where: { staffRoleKey: "super_admin", status: "active" },
        include: { staffRole: true },
      }),
    );
    const manager = await runtime.tx.run((tx) =>
      tx.staff.findFirstOrThrow({
        where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
      }),
    );
    const merchant = await make.subscribedMerchant(),
      keyring = loadKeyring(runtime.env);
    await runtime.tx.run((tx) =>
      tx.store.update({
        where: { id: merchant.store.id },
        data: { name: `${own.prefix}-${connection.runId}` },
      }),
    );
    const tenant = createTenant(runtime),
      docs = createDocs(runtime),
      wechat = createFakeWechat();
    const identity = createIdentity({
      ...runtime,
      docs,
      tenant,
      wechat,
      keyring: () => keyring,
      appid: "wx0000000000000000",
    });
    const consents = await runtime.tx.run(async (tx) =>
      Promise.all(
        ["user", "privacy"].map(async (agreementKey) => ({
          agreementKey,
          agreementVersionId: (
            await tx.agreementVersion.findFirstOrThrow({
              where: { agreementKey, status: "active" },
              orderBy: { effectiveAt: "desc" },
            })
          ).id,
        })),
      ),
    );
    const code = `${own.loginPrefix}-${connection.runId}`;
    wechat.sessions.set(code, { openid: `${code}-owner` });
    if (!merchant.user.phoneEnc) throw new Error("本轮老板缺少测试手机号");
    wechat.phones.set(code, openField(keyring, "merchant_user.phone_enc", merchant.user.phoneEnc));
    phase = "owner_phone_login";
    const login = await identity.phoneLogin(
      { requestId: code, ip: "127.0.0.1", userAgent: "lyxtest W119B", clientVersion: "1.0.0" },
      { loginCode: code, phoneCode: code, consents },
    );
    if (login.me.user.merchantUserId !== merchant.user.id)
      throw new Error("W119B 老板会话归属不一致");
    const ownerCtx = createIdentityContext({
      actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    });
    const publish = createPublish(runtime);
    const screenshot = await make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      uploadActorType: "merchant",
      uploadActorId: merchant.user.id,
      uploadClient: "weapp",
    });
    phase = "bind_account";
    const account = await publish.bind(
      {
        ctx: ownerCtx,
        membership: {
          memberId: merchant.owner.id,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          role: "owner",
          storeMode: "active",
        },
      },
      {
        platform: "douyin",
        accountName: `${own.prefix}发布号`,
        accountUid: `${own.loginPrefix}_${connection.runId}`,
        accountType: "none",
        screenshotFileIds: [screenshot.id],
      },
    );
    const round = await runtime.tx.run((tx) =>
      tx.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: account.channelAccountId },
        include: { approvalRequest: true },
      }),
    );
    const template = await runtime.tx.run((tx) =>
      tx.checklistTemplate.findFirstOrThrow({
        where: { code: "account.verify", status: "active" },
      }),
    );
    const staff = buildStaffContext({
      staff: {
        id: admin.id,
        roleKey: "super_admin",
        isLead: admin.isLead,
        staffGroupId: admin.staffGroupId,
      },
      role: normalizeRoleConfig("super_admin", admin.staffRole),
      groupStaffIds: [],
      stepUpAt: runtime.clock.now(),
    });
    phase = "approve_account";
    await publish.approveAccount(
      createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
      staff,
      round.id,
      {
        lockVersion: round.approvalRequest.lockVersion,
        confirm: { roundNo: round.roundNo, accountUid: `${own.loginPrefix}_${connection.runId}` },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        checklistVersionNo: template.versionNo,
        results: ChecklistItemsSchema.parse(template.items).map((item) => ({
          key: item.key,
          result: "pass",
        })),
      },
    );
    const order = await make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      placedByUserId: merchant.user.id,
      subscriptionTermId: merchant.term.id,
      status: "producing",
      totalChargePoints: 200,
      itemCount: 1,
      focusCodes: ["W119F"],
    });
    if (own.loginPrefix === "w513") phase = "historical_poster";
    const poster =
      own.loginPrefix === "w513" ? await prepareW513Poster(runtime, connection.runId) : undefined;
    const drama = await make.drama({
      title: `${own.prefix}短剧-${connection.runId}`,
      totalEpisodes: 2,
      dramaClass: "class_1",
      isAiGenerated: false,
      createdByStaffId: admin.id,
      ...(poster
        ? {
            posterFileId: poster.fileId,
            synopsis: "W513隔离页面演练短剧，用于完整发布清单与成片交付验证。",
          }
        : {}),
    });
    const licenseEndDate = addDays(calendarDate(runtime.clock.now()), 365),
      permits =
        own.loginPrefix === "w513"
          ? [{ kind: "license_no", number: `W513-TEST-${connection.runId}`, platform: "douyin" }]
          : [];
    if (own.loginPrefix === "w513") {
      phase = "historical_license_inputs";
      // Fictional upstream historical inputs, matching prepareOrderDrama's initial structure.
      // Neither a copyright revision result nor any authorization/render success is fabricated.
      await runtime.tx.run(async (tx) => {
        const now = runtime.clock.now();
        await tx.dramaCopyright.create({
          data: {
            dramaId: drama.id,
            source: "licensed",
            platforms: ["douyin"],
            territory: "中国大陆",
            hasNetworkRight: true,
            canSublicense: true,
            canEditEmbed: true,
            canAdapt: true,
            licenseStartDate: new Date(`${calendarDate(now)}T00:00:00Z`),
            licenseEndDate: new Date(`${licenseEndDate}T00:00:00Z`),
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.dramaPermit.create({
          data: {
            id: uuidv7(),
            dramaId: drama.id,
            platform: permits[0]!.platform,
            permitKind: permits[0]!.kind,
            permitNo: permits[0]!.number,
            status: "active",
            note: "W513隔离页面验收的虚构上游历史许可输入，非正式许可证",
            createdByStaffId: admin.id,
            createdAt: now,
            updatedAt: now,
          },
        });
      });
    }
    const snapshot = DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: 2,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits,
      licenseEndDate,
      posterFileId: poster?.fileId ?? null,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: false,
    });
    const item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: drama.id,
      phase: "producing",
      episodeCount: 2,
      listPricePoints: 200,
      chargePoints: 200,
      dramaSnapshot: snapshot,
    });
    phase = "create_tickets";
    const result = await runtime.tx.run(async (tx) => {
      await tx.orderItemAccount.create({
        data: {
          orderItemId: item.id,
          channelAccountId: account.channelAccountId,
          platform: "douyin",
          createdAt: runtime.clock.now(),
        },
      });
      await prepareTicketAssignees(tx, order.id);
      return createTickets(
        tx,
        { ...runtime, sla: createSla(runtime) },
        createIdentityContext({
          actor: { type: "system", job: "lyxtest.w119b_fixture" },
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
        }),
        { dramaOrderId: order.id },
      );
    });
    const ticketId = result.deliveryTicketIds[0]!,
      ticket = await runtime.tx.run((tx) =>
        tx.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
      );
    const launch = await runtime.tx.run(async (tx) =>
      createSla(runtime).nthWorkdayAfter(tx, {
        policy: "plan.launch_min",
        amount: 7,
        from: calendarDate(order.submittedAt),
        workHours: await workHoursAt(tx, runtime.clock.now()),
      }),
    );
    return {
      scope: {
        ...connection,
        startedAt,
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        orderId: order.id,
        itemId: item.id,
        ticketId,
        uploaderId: admin.id,
        managerId: manager.id,
      },
      ticketNo: ticket.ticketNo,
      orderNo: order.orderNo,
      planId: result.deliveryPlanId,
      accountId: account.channelAccountId,
      accountName: `${own.prefix}发布号`,
      ownerHeaders: {
        authorization: `Bearer ${login.token}`,
        "X-Store-Id": merchant.store.id,
        "X-Client-Version": "1.0.0",
      },
      launchDate: launch.date,
      deliveryDate: addDays(calendarDate(runtime.clock.now()), 3),
      ...(poster ? { posterProof: poster } : {}),
    };
  } catch (error) {
    if (own.loginPrefix === "w513")
      process.stderr.write(
        `${JSON.stringify({ evt: "w513.flow_fixture.failed", phase, symbol: isAppError(error) ? error.error : "non_application" })}\n`,
      );
    throw error;
  }
}
const fixture: AdminLiveFixture = (context) => prepareDeliveryLiveFixture(context);
export default fixture;
