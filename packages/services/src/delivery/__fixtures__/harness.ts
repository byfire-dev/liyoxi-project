import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../../approval/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implement,
  invariantsPort,
  uuidv7,
} from "../../kernel/index.js";
import type { InvariantReport, Tx } from "../../kernel/index.js";
import { createMedia } from "../../media/index.js";
import type { MediaProductionDeps } from "../../media/index.js";
import { bindPublish, createPublish } from "../../publish/index.js";
import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import { createProfile } from "../../profile/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { readCancelReviewCause } from "../../order/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
  TEST_KEYRING,
} from "../../testing/index.js";
import { bindDelivery } from "../binding.js";
import { createTickets, prepareTicketAssignees } from "../create.js";
import { orderSidePort } from "../ports.js";
import type { OrderSide } from "../ports.js";
import { createDelivery } from "../service.js";
import type { DeliveryViewer } from "../context.js";
export function harness(
  prisma: PrismaClient,
  apply = true,
  production?: (input: {
    prisma: PrismaClient;
    clock: ReturnType<typeof createClock>;
    fake: ReturnType<typeof createFakeProviders>;
  }) => MediaProductionDeps,
) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    reports: InvariantReport[] = [],
    applications: string[] = [];
  const rederivations: Array<{ steps: string[]; input: Parameters<OrderSide["rederive"]>[1] }> = [];
  const rederiveHook: { run?: OrderSide["rederive"] } = {};
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_delivery", {
        portImplementations: [
          implement(invariantsPort, {
            report: async (r) => {
              reports.push(r);
            },
          }),
          ...(apply
            ? [
                implement(orderSidePort, {
                  readCancelReviewCause,
                  // 测试装配的订单写侧样例；生产保持 INTERNAL，W1-17 必须注册自己的真实实现。
                  async applyConfirmedPlan(t, input) {
                    applications.push(input.deliveryPlanId);
                    for (const row of input.content.items) {
                      await t.orderItem.update({
                        where: { id: row.orderItemId },
                        data: { agreedLaunchDate: new Date(row.agreedLaunchDate!) },
                      });
                      await t.orderItemAccount.deleteMany({
                        where: { orderItemId: row.orderItemId },
                      });
                      for (const a of row.accounts)
                        await t.orderItemAccount.create({
                          data: { orderItemId: row.orderItemId, ...a, createdAt: clock.now() },
                        });
                      await t.orderItemPlacement.deleteMany({
                        where: { orderItemId: row.orderItemId },
                      });
                      for (const a of row.placements)
                        await t.orderItemPlacement.create({
                          data: {
                            id: uuidv7(),
                            orderItemId: row.orderItemId,
                            ...a,
                            createdAt: clock.now(),
                            updatedAt: clock.now(),
                          },
                        });
                    }
                    for (const storeAssetId of input.content.referenceAssetIds)
                      await t.storeAssetUsage.upsert({
                        where: {
                          storeAssetId_usedByType_usedById_role: {
                            storeAssetId,
                            usedByType: "drama_order",
                            usedById: input.dramaOrderId,
                            role: "reference",
                          },
                        },
                        create: {
                          id: uuidv7(),
                          storeAssetId,
                          usedByType: "drama_order",
                          usedById: input.dramaOrderId,
                          role: "reference",
                          createdAt: clock.now(),
                        },
                        update: {},
                      });
                  },
                  async rederive(t, input) {
                    const tickets = await t.deliveryTicket.findMany({
                      where: { orderItemId: { in: [...input.orderItemIds] } },
                      orderBy: { id: "asc" },
                    });
                    rederivations.push({ steps: tickets.map((r) => r.step), input });
                    await rederiveHook.run?.(t, input);
                  },
                }),
              ]
            : []),
        ],
      }),
    ],
  });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ assembly, clock, events }),
    fake = createFakeProviders({ clock }),
    make = createFactories({ db: prisma, clock });
  const tenant = createTenant({ tx, clock, assembly, flow }),
    approval = createApproval({
      assembly,
      clock,
      flow,
      events,
      bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
    });
  const media = createMedia({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    production: production?.({ prisma, clock, fake }),
  });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    tenant,
    approval,
    events,
    media,
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    currentOpenid: async () => "lyxtest_delivery_openid",
  });
  const unbindPublish = bindPublish(assembly),
    publish = createPublish({ tx, clock, assembly, approval, flow, media });
  const deps = {
      publish,
      tx,
      clock,
      assembly,
      flow,
      events,
      media,
      profile,
      sla: createSla({ clock, assembly }),
    },
    unbindDelivery = bindDelivery(deps),
    delivery = createDelivery(deps);
  const unbind = () => {
    unbindPublish();
    unbindDelivery();
  };
  async function staff(role = "super_admin") {
    const row = await make.staff({ staffRoleKey: role, isLead: true });
    return {
      row,
      staff: await sampleStaffContext(prisma, row.id),
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    };
  }
  async function order(
    hasManager = false,
    count = 1,
    posterFileId?: string,
    episodeCount?: number,
  ) {
    await prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "custom_focus", code: "CF01" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "custom_focus",
        code: "CF01",
        name: "测试定制重点",
        isEnabled: true,
        position: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
      update: {},
    });
    const user = await make.merchantUser(),
      entity = await make.entity({ createdByUserId: user.id, verificationStatus: "verified" }),
      manager = hasManager ? await make.staff({ staffRoleKey: "delivery_manager" }) : null;
    const store = await make.store({
        entityId: entity.id,
        deliveryManagerId: manager?.id,
        qualificationStatus: "verified",
        isPrimary: true,
      }),
      member = await make.entityMember({
        entityId: entity.id,
        merchantUserId: user.id,
        role: "owner",
      });
    const order = await make.dramaOrder({
      entityId: entity.id,
      storeId: store.id,
      status: "producing",
      deliveryManagerId: manager?.id,
      itemCount: count,
      totalChargePoints: 100 * count,
    });
    const items = [];
    for (let i = 0; i < count; i++)
      items.push(
        await make.orderItem({
          dramaOrderId: order.id,
          phase: "producing",
          ...(episodeCount !== undefined ? { episodeCount } : {}),
          dramaSnapshot: {
            title: `测试短剧${i + 1}`,
            genreCodes: ["G01"],
            ...(posterFileId ? { posterFileId } : {}),
          },
        }),
      );
    const viewer: DeliveryViewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
        entityId: entity.id,
        storeId: store.id,
      }),
      membership: {
        memberId: member.id,
        entityId: entity.id,
        storeId: store.id,
        role: "owner",
        storeMode: "active",
      },
    };
    const made = await tx.run(async (t) => {
      await prepareTicketAssignees(t, order.id);
      return createTickets(t, deps, viewer.ctx, { dramaOrderId: order.id });
    });
    const screenshot = await make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: entity.id,
      storeId: store.id,
      uploadActorType: "merchant",
      uploadActorId: user.id,
      uploadClient: "weapp",
    });
    const bound = await publish.bind(viewer, {
      platform: "douyin",
      accountName: "测试发布号",
      accountUid: `LYX${uuidv7()}`,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
    const submission = await prisma.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: bound.channelAccountId },
        include: { approvalRequest: true, channelAccount: true },
      }),
      checklist = await prisma.checklistTemplate.findFirstOrThrow({
        where: { code: "account.verify", status: "active" },
      }),
      admin = await staff();
    await publish.approveAccount(admin.ctx, admin.staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: submission.roundNo, accountUid: submission.channelAccount.accountUid },
      accountType: "none",
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      checklistVersionNo: checklist.versionNo,
      results: ChecklistItemsSchema.parse(checklist.items).map((i) => ({
        key: i.key,
        result: "pass",
      })),
    });
    const account = await prisma.channelAccount.findUniqueOrThrow({
      where: { id: bound.channelAccountId },
    });
    return { user, entity, store, member, viewer, order, items, account, ...made };
  }
  const counts = async (t: Tx, id: string) => ({
    history: await t.statusTransition.count({ where: { subjectId: id } }),
    events: await t.outboxEvent.count({ where: { aggregateId: id } }),
    audit: await t.auditLog.count({ where: { targetId: id } }),
  });
  return {
    prisma,
    clock,
    tx,
    assembly,
    make,
    fake,
    media,
    flow,
    events,
    profile,
    deps,
    delivery,
    unbind,
    staff,
    order,
    reports,
    applications,
    counts,
    rederivations,
    rederiveHook,
  };
}
export type Harness = ReturnType<typeof harness>;
export const draft = (o: Awaited<ReturnType<Harness["order"]>>) => ({
  focusCodes: ["CF01"],
  referenceAssetIds: [],
  launchMode: "merchant_self" as const,
  note: "测试定制说明",
  items: o.items.map((i) => ({
    orderItemId: i.id,
    channelAccountIds: [o.account.id],
    placements: [],
    agreedLaunchDate: "2026-01-20",
    expectedDeliveryDate: null,
  })),
});
