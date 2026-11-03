import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, loadEnv, lockRows, uuidv7 } from "../kernel/index.js";
import { createPublish, createPublishPatrol, createChannelHealth } from "../publish/index.js";
import { createRuntime } from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { createFactories } from "./data/index.js";
import { sampleStaffContext } from "./approval.js";
import { createFakeProviders } from "./providers/index.js";
import { createClock } from "./clock.js";
import { fakeKeyEnv } from "./m1-fake-keys.js";
import { TEST_KEYRING } from "./data/seal.js";

export function createPatrolTestRuntime(input: {
  databaseUrl: string;
  redisUrl: string;
  redisKeyPrefix: string;
}) {
  const clock = createClock(),
    providers = createFakeProviders({ clock });
  const runtime = createRuntime({
    entry: "api",
    version: "test",
    clock,
    env: {
      ...loadEnv({ APP_ENV: "test", DATABASE_URL: input.databaseUrl, REDIS_URL: input.redisUrl }),
      ...fakeKeyEnv(),
    },
    providers,
    billingKeyring: TEST_KEYRING,
    redisKeyPrefix: input.redisKeyPrefix,
  });
  return { runtime, clock, providers };
}
/**
 * Controlled historical pending-launch boundary, using the existing factory's valid
 * order/hold/ticket inputs. It does not prove delivery or payment production.
 * Account review, launch submission/approval and item/ticket/order live derivation
 * below use the real runtime bindings. No live or patrol success state is seeded.
 */
export async function createPatrolTestSubject(runtime: Runtime, prisma: PrismaClient) {
  const make = createFactories({ db: prisma, clock: runtime.clock });
  const merchant = await make.merchant({ verified: true });
  const manager = await make.staff({ staffRoleKey: "delivery_manager" });
  const publisher = await make.staff({ staffRoleKey: "publisher" });
  const admin = await make.staff({ staffRoleKey: "super_admin" });
  await prisma.store.update({
    where: { id: merchant.store.id },
    data: { deliveryManagerId: manager.id },
  });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
  });
  const viewer = {
    ctx,
    membership: {
      memberId: merchant.owner.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  const adminCtx = createIdentityContext({
    actor: { type: "staff", id: admin.id, client: "admin" },
  });
  const staff = await sampleStaffContext(prisma, admin.id, { stepUpAt: runtime.clock.now() });
  // patrol_issue is an operator-maintained dictionary: main seeds its type only.
  if (
    !(await prisma.dictItem.findFirst({ where: { dictTypeKey: "patrol_issue", isEnabled: true } }))
  )
    await runtime.configAdmin.createDictItem(
      { identity: adminCtx, staff },
      { typeKey: "patrol_issue", name: "测试人工查见异常" },
    );
  const deps = {
    tx: runtime.tx,
    clock: runtime.clock,
    assembly: runtime.assembly,
    approval: runtime.approval,
    flow: runtime.flow,
    media: runtime.media,
    events: runtime.events,
    timers: runtime.timers,
  };
  const publish = createPublish(deps),
    patrol = createPublishPatrol(deps),
    health = createChannelHealth(deps);
  async function checks(code: string) {
    const template = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code, status: "active" },
    });
    return {
      checklistVersionNo: template.versionNo,
      results: ChecklistItemsSchema.parse(template.items).map((i) => ({
        key: i.key,
        result: "pass" as const,
      })),
    };
  }
  async function bindAccount(approve = true) {
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
    const card = await publish.bind(viewer, {
      platform: "douyin",
      accountName: "巡检测试账号",
      accountUid: `patrol${uuidv7()}`,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
    const sub = await prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: card.channelAccountId },
      include: { approvalRequest: true, channelAccount: true },
    });
    const approvalBody = {
      lockVersion: sub.approvalRequest.lockVersion,
      confirm: { roundNo: sub.roundNo, accountUid: sub.channelAccount.accountUid },
      accountType: "none" as const,
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      ...(await checks("account.verify")),
    };
    if (approve) await publish.approveAccount(adminCtx, staff, sub.id, approvalBody);
    return { id: card.channelAccountId, sub, approvalBody };
  }
  async function launch() {
    const account = await bindAccount(),
      now = runtime.clock.now();
    const order = await make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      status: "to_launch",
    });
    const item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "to_launch",
      episodeCount: 1,
      dramaSnapshot: { title: "巡检历史待上线短剧" },
      agreedLaunchDate: new Date(calendarDate(now)),
    });
    const ticket = await make.deliveryTicket({
      orderItemId: item.id,
      step: "awaiting_launch",
      deliveredAt: now,
      deliveryManagerId: manager.id,
      publisherId: publisher.id,
      waitingOn: "merchant",
    });
    await prisma.orderItemAccount.create({
      data: {
        orderItemId: item.id,
        channelAccountId: account.id,
        platform: "douyin",
        createdAt: now,
      },
    });
    const taskIds = await runtime.tx.run(async (tx) => {
      await lockRows(tx, "drama_order", [order.id]);
      await lockRows(tx, "order_item", [item.id]);
      await lockRows(tx, "delivery_ticket", [ticket.id]);
      await lockRows(tx, "channel_account", [account.id]);
      return publish.createLaunchTasks(tx, ctx, {
        orderItemId: item.id,
        deliveryTicketId: ticket.id,
        channelAccountIds: [account.id],
      });
    });
    const id = taskIds[0]!;
    await publish.submitLaunch(viewer, id, {
      linkKind: "collection",
      collectionUrl: `https://example.invalid/patrol/${id}`,
      reportedEpisodeCount: 1,
      actualLaunchDate: calendarDate(now),
    });
    const sub = await prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: id },
      include: { approvalRequest: true },
    });
    await publish.approveLaunch(adminCtx, staff, sub.id, {
      lockVersion: sub.approvalRequest.lockVersion,
      confirm: { roundNo: sub.roundNo, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await checks("launch.verify")),
    });
    return {
      taskId: id,
      accountId: account.id,
      orderId: order.id,
      itemId: item.id,
      ticketId: ticket.id,
    };
  }
  async function evidence() {
    return (
      await make.fileObject({
        category: "evidence",
        bucket: "secure",
        scopeType: "store",
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        uploadActorType: "staff",
        uploadActorId: admin.id,
        uploadClient: "admin",
      })
    ).id;
  }
  return {
    runtime,
    prisma,
    make,
    merchant,
    manager,
    publisher,
    admin,
    adminCtx,
    staff,
    viewer,
    publish,
    patrol,
    health,
    checks,
    bindAccount,
    launch,
    evidence,
  };
}
