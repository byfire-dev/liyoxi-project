import { createHash } from "node:crypto";
import { ChecklistItemsSchema, COMPARE_FIELDS, DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../../delivery/index.js";
import { createPublish } from "../../publish/index.js";
import { createIdentity } from "../../identity/index.js";
import { createTenant } from "../../tenant/index.js";
import { createDocs } from "../../docs/index.js";
import { createMedia } from "../../media/index.js";
import { demoImage } from "../../content/index.js";
import { createMinioStorage } from "../../providers/index.js";
import { createSla } from "../../sla/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import { issueActivationCode, base32Decode, hotp, totpStep } from "../../staff/index.js";
import { createFakeWechat } from "../providers/index.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import { parseW608LiveScope } from "./w608-scope.js";
import type { AdminLiveFixture } from "./context.js";

/** One two-episode initial order. All accounts are approved through their real owner service. */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const live = assertDeliveryLiveEnvironment(runtime.env),
    startedAt = runtime.clock.now().toISOString();
  const [admin, manager] = await runtime.tx.run(async (tx) =>
    Promise.all([
      tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
      tx.staff.findFirstOrThrow({
        where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
      }),
    ]),
  );
  const ctx = createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } });
  const staff = await runtime.tx.run((tx) =>
    sampleStaffContext(tx, admin.id, { stepUpAt: runtime.clock.now() }),
  );
  const merchant = await make.subscribedMerchant(),
    foreign = await make.subscribedMerchant();
  await runtime.tx.run(async (tx) => {
    await tx.store.update({
      where: { id: merchant.store.id },
      data: {
        name: `W608发布门店-${live.runId}`,
        deliveryManagerId: manager.id,
      },
    });
    await tx.store.update({
      where: { id: foreign.store.id },
      data: { name: `W608跨店反例-${live.runId}` },
    });
    await tx.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "custom_focus",
        code: "W608F",
        name: "W608发布演练重点",
        isEnabled: true,
        position: 999,
        ext: {},
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
    });
  });
  const viewer = (value: typeof merchant) => ({
    ctx: createIdentityContext({
      actor: {
        type: "merchant" as const,
        id: value.user.id,
        client: "weapp" as const,
        role: "owner" as const,
      },
      entityId: value.entity.id,
      storeId: value.store.id,
    }),
    membership: {
      memberId: value.owner.id,
      entityId: value.entity.id,
      storeId: value.store.id,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  });
  const publish = createPublish(runtime),
    template = await runtime.tx.run((tx) =>
      tx.checklistTemplate.findFirstOrThrow({
        where: { code: "account.verify", status: "active" },
      }),
    );
  const account = async (
    value: typeof merchant,
    platform: "douyin" | "wechat_channels",
    suffix: string,
  ) => {
    const screenshot = await make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: value.entity.id,
      storeId: value.store.id,
      uploadActorType: "merchant",
      uploadActorId: value.user.id,
      uploadClient: "weapp",
    });
    const accountName = `W608${suffix}-${live.runId}`,
      accountUid = `w608_${suffix === "原订单抖音号" ? "original" : suffix === "店内新视频号" ? "extra" : "foreign"}_${live.runId}`;
    const created = await publish.bind(viewer(value), {
      platform,
      accountName,
      accountUid,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
    const round = await runtime.tx.run((tx) =>
      tx.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: created.channelAccountId },
        include: { approvalRequest: true },
      }),
    );
    await publish.approveAccount(ctx, staff, round.id, {
      lockVersion: round.approvalRequest.lockVersion,
      confirm: { roundNo: round.roundNo, accountUid },
      accountType: "none",
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      checklistVersionNo: template.versionNo,
      results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
        key,
        result: "pass" as const,
      })),
    });
    return { id: created.channelAccountId, name: accountName, platform };
  };
  const original = await account(merchant, "douyin", "原订单抖音号"),
    extra = await account(merchant, "wechat_channels", "店内新视频号"),
    outside = await account(foreign, "wechat_channels", "跨店视频号");
  const storage = createMinioStorage(),
    media = createMedia({ ...runtime, storage });
  let poster;
  try {
    const body = demoImage([100, 150, 170]);
    poster = await media.putSystemFile({
      category: "poster",
      fileName: "w608-poster.png",
      body,
      objectKey: `poster/w608/${live.runId}.png`,
      entityId: null,
      storeId: null,
    });
    const stored = await storage.readObject({
      bucket: "pub",
      key: `poster/w608/${live.runId}.png`,
      maxBytes: body.length,
    });
    if (!stored.ok || createHash("sha256").update(stored.value).digest("hex") !== poster.sha256)
      throw new Error("W608 poster bytes were not persisted");
  } finally {
    await media.jobs.shutdown();
    await storage.close();
  }
  const today = calendarDate(runtime.clock.now()),
    launchDate = addDays(today, -1),
    deliveryDate = addDays(today, -2);
  const order = await make.dramaOrder({
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    placedByUserId: merchant.user.id,
    subscriptionTermId: merchant.term.id,
    status: "producing",
    totalChargePoints: 200,
    itemCount: 1,
    focusCodes: ["W608F"],
    submittedAt: new Date(`${addDays(today, -30)}T00:00:00Z`),
  });
  const permits = ["douyin", "wechat_channels"].map((platform) => ({
    platform,
    kind: "license_no",
    number: `W608-TEST-${live.runId}`,
  }));
  const drama = await make.drama({
    title: `W608发布短剧-${live.runId}`,
    totalEpisodes: 2,
    dramaClass: "class_1",
    isAiGenerated: false,
    createdByStaffId: admin.id,
    posterFileId: poster.fileId,
    synopsis: "隔离页面验收的两集短剧与发布清单。",
  });
  await runtime.tx.run(async (tx) => {
    const now = runtime.clock.now();
    await tx.dramaCopyright.create({
      data: {
        dramaId: drama.id,
        source: "licensed",
        platforms: ["douyin", "wechat_channels"],
        territory: "中国大陆",
        hasNetworkRight: true,
        canSublicense: true,
        canEditEmbed: true,
        canAdapt: true,
        licenseStartDate: new Date(`${addDays(today, -365)}T00:00:00Z`),
        licenseEndDate: new Date(`${addDays(today, 365)}T00:00:00Z`),
        createdAt: now,
        updatedAt: now,
      },
    });
    for (const permit of permits)
      await tx.dramaPermit.create({
        data: {
          id: uuidv7(),
          dramaId: drama.id,
          platform: permit.platform,
          permitKind: permit.kind,
          permitNo: permit.number,
          status: "active",
          note: "W608隔离测试虚构上游许可输入",
          createdByStaffId: admin.id,
          createdAt: now,
          updatedAt: now,
        },
      });
  });
  const item = await make.orderItem({
    dramaOrderId: order.id,
    dramaId: drama.id,
    phase: "producing",
    episodeCount: 2,
    listPricePoints: 200,
    chargePoints: 200,
    dramaSnapshot: DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: 2,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits,
      licenseEndDate: addDays(today, 365),
      posterFileId: poster.fileId,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: false,
    }),
  });
  const made = await runtime.tx.run(async (tx) => {
    await tx.orderItemAccount.create({
      data: {
        orderItemId: item.id,
        channelAccountId: original.id,
        platform: original.platform,
        createdAt: runtime.clock.now(),
      },
    });
    await prepareTicketAssignees(tx, order.id);
    return createTickets(
      tx,
      { ...runtime, sla: createSla(runtime) },
      createIdentityContext({
        actor: { type: "system", job: "lyxtest.w608_fixture" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      { dramaOrderId: order.id },
    );
  });
  const ticket = await runtime.tx.run((tx) =>
    tx.deliveryTicket.findUniqueOrThrow({ where: { id: made.deliveryTicketIds[0]! } }),
  );
  const keyring = loadKeyring(runtime.env),
    wechat = createFakeWechat(),
    tenant = createTenant(runtime);
  const identity = createIdentity({
    ...runtime,
    tenant,
    docs: createDocs(runtime),
    wechat,
    keyring: () => keyring,
    appid: "wx0000000000000000",
  });
  const loginCode = `w608-${live.runId}`;
  if (!merchant.user.phoneEnc) throw new Error("W608 owner phone is missing");
  wechat.sessions.set(loginCode, { openid: `${loginCode}-owner` });
  wechat.phones.set(
    loginCode,
    openField(keyring, "merchant_user.phone_enc", merchant.user.phoneEnc),
  );
  const consents = await runtime.tx.run((tx) =>
    tx.agreementVersion.findMany({
      where: { agreementKey: { in: ["user", "privacy"] }, status: "active" },
    }),
  );
  const login = await identity.phoneLogin(
    { requestId: loginCode, ip: "127.0.0.1", userAgent: "W608 live", clientVersion: "1.0.0" },
    {
      loginCode,
      phoneCode: loginCode,
      consents: consents.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
    },
  );
  if (login.me.user.merchantUserId !== merchant.user.id)
    throw new Error("W608 owner login changed identity");
  // Reuse the existing read-only cs actor. No role, group, range, active state or staff count changes.
  const viewerStaff = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({
      where: { name: "演练客服", staffRoleKey: "cs", status: "active" },
    }),
  );
  const viewerPhone = openField(keyring, "staff.phone_enc", viewerStaff.phoneEnc),
    viewerPassword = "Liyoxi-W608-viewer-2026";
  const viewerMeta = { ip: "127.0.0.1", userAgent: `lyxtest W608 ${live.runId}` };
  const issued = await runtime.tx.run((tx) =>
    issueActivationCode(tx, {
      staffId: viewerStaff.id,
      purpose: "activate",
      delivery: "manual",
      createdByStaffId: null,
      now: runtime.clock.now(),
    }),
  );
  const activated = await runtime.staffAuth.activate({
    phone: viewerPhone,
    activationCode: issued.code,
  });
  if (!activated.ticket) throw new Error("W608 viewer activation ticket missing");
  const set = await runtime.staffAuth.setPassword({
    ticket: activated.ticket,
    newPassword: viewerPassword,
    meta: viewerMeta,
  });
  if (!set.ticket) throw new Error("W608 viewer enrollment ticket missing");
  const enrolled = await runtime.staffAuth.enrollTotp({ ticket: set.ticket });
  const signed = await runtime.staffAuth.confirmTotp({
    ticket: enrolled.ticket,
    code: hotp(base32Decode(enrolled.secret), totpStep(runtime.clock.now())),
    meta: viewerMeta,
  });
  if (!signed.recoveryCodes?.length) throw new Error("W608 viewer enrollment did not finish");
  return {
    scope: parseW608LiveScope({
      ...live,
      startedAt,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      orderId: order.id,
      itemId: item.id,
      ticketId: ticket.id,
      dramaId: drama.id,
      planId: made.deliveryPlanId,
      merchantUserId: merchant.user.id,
      memberId: merchant.owner.id,
      posterFileId: poster.fileId,
      uploaderId: admin.id,
      managerId: manager.id,
      accountIds: [original.id, extra.id],
      foreign: { entityId: foreign.entity.id, storeId: foreign.store.id, accountId: outside.id },
    }),
    viewer: {
      staffId: viewerStaff.id,
      name: viewerStaff.name,
      phone: viewerPhone,
      password: viewerPassword,
      recoveryCodes: signed.recoveryCodes,
    },
    ticketNo: ticket.ticketNo,
    orderNo: order.orderNo,
    storeName: `W608发布门店-${live.runId}`,
    title: drama.title,
    accounts: [original, extra],
    foreignAccount: outside,
    launchDate,
    deliveryDate,
    ownerHeaders: {
      authorization: `Bearer ${login.token}`,
      "X-Store-Id": merchant.store.id,
      "X-Client-Version": "1.0.0",
    },
  };
};
export default fixture;
