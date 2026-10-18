import { ChecklistItemsSchema, COMPARE_FIELDS, DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { createDocs } from "../../docs/index.js";
import { createIdentity } from "../../identity/index.js";
import { createIdentityContext } from "../../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../../delivery/index.js";
import { createPublish } from "../../publish/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import { createSla, workHoursAt } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { createFakeWechat } from "../providers/index.js";
import type { AdminLiveFixture } from "./context.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

/** 本包独立两集前置；不改旧员工、旧订单搜索范围或旧账号核验队列。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
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
      data: { name: `制作演练-${connection.runId}` },
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
  const code = `w119b-${connection.runId}`;
  wechat.sessions.set(code, { openid: `${code}-owner` });
  if (!merchant.user.phoneEnc) throw new Error("本轮老板缺少测试手机号");
  wechat.phones.set(code, openField(keyring, "merchant_user.phone_enc", merchant.user.phoneEnc));
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
      accountName: "制作演练发布号",
      accountUid: `w119b_${connection.runId}`,
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
    tx.checklistTemplate.findFirstOrThrow({ where: { code: "account.verify", status: "active" } }),
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
  await publish.approveAccount(
    createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
    staff,
    round.id,
    {
      lockVersion: round.approvalRequest.lockVersion,
      confirm: { roundNo: round.roundNo, accountUid: `w119b_${connection.runId}` },
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
  const drama = await make.drama({
    title: `制作演练短剧-${connection.runId}`,
    totalEpisodes: 2,
    dramaClass: "class_1",
    isAiGenerated: false,
    createdByStaffId: admin.id,
  });
  const snapshot = DramaSnapshotSchema.parse({
    dramaId: drama.id,
    title: drama.title,
    totalEpisodes: 2,
    dramaClass: drama.dramaClass,
    genreCodes: drama.genreCodes,
    permits: [],
    licenseEndDate: addDays(calendarDate(runtime.clock.now()), 365),
    posterFileId: null,
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
    accountName: "制作演练发布号",
    ownerHeaders: {
      authorization: `Bearer ${login.token}`,
      "X-Store-Id": merchant.store.id,
      "X-Client-Version": "1.0.0",
    },
    launchDate: launch.date,
    deliveryDate: addDays(calendarDate(runtime.clock.now()), 3),
  };
};
export default fixture;
