import type { PrismaClient } from "@liyoxi/db";
import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { ChannelAccountApproveBody, LaunchApproveBody } from "@liyoxi/contract";
import { createApproval } from "../../approval/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implement,
  uuidv7,
} from "../../kernel/index.js";
import { createMedia } from "../../media/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
} from "../../testing/index.js";
import { bindPublish } from "../binding.js";
import { launchChangedPort } from "../ports.js";
import { createPublish, getLaunchFacts } from "../service.js";
import type { PublishViewer } from "../context.js";
export function harness(prisma: PrismaClient) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    changes: Array<Awaited<ReturnType<typeof getLaunchFacts>>> = [];
  // 仅夹具模拟未来 delivery 端口的步骤求值；生产的默认端口保持空实现。
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_publish", {
        portImplementations: [
          implement(launchChangedPort, async (t, input) => {
            const facts = await getLaunchFacts(t, input.orderItemId);
            changes.push(facts);
            await t.deliveryTicket.update({
              where: { id: input.deliveryTicketId },
              data: {
                step: facts.hasLive
                  ? "in_service"
                  : facts.hasVerifying
                    ? "launch_verify"
                    : "awaiting_launch",
              },
            });
          }),
        ],
      }),
    ],
  });
  const unbind = bindPublish(assembly),
    make = createFactories({ db: prisma, clock }),
    fake = createFakeProviders({ clock });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ assembly, clock, events });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  const publish = createPublish({ tx, clock, assembly, approval, flow, media });
  async function owner(mode: "full" | "parallel" | "blocked" = "full") {
    const user = await make.merchantUser(),
      entity = await make.entity({
        createdByUserId: user.id,
        verificationStatus: "verified",
        name: "测试发布主体",
      });
    const store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      qualificationStatus:
        mode === "full" ? "verified" : mode === "parallel" ? "pending" : "unsubmitted",
    });
    const member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: user.id,
      role: "owner",
    });
    const viewer: PublishViewer = {
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
    return { user, entity, store, viewer };
  }
  async function screenshot(viewer: PublishViewer) {
    return make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      uploadActorType: "merchant",
      uploadActorId: viewer.ctx.actor.id!,
      uploadClient: "weapp",
    });
  }
  async function staff() {
    const row = await make.staff({ staffRoleKey: "super_admin" });
    return {
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
      staff: await sampleStaffContext(prisma, row.id),
      row,
    };
  }
  async function checks(code: string) {
    const row = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code, status: "active" },
    });
    return {
      checklistVersionNo: row.versionNo,
      results: ChecklistItemsSchema.parse(row.items).map((i) => ({
        key: i.key,
        result: "pass" as const,
      })),
    };
  }
  async function approveBody(id: string): Promise<ChannelAccountApproveBody> {
    const r = await prisma.channelAccountSubmission.findUniqueOrThrow({
      where: { id },
      include: { channelAccount: true, approvalRequest: true },
    });
    return {
      lockVersion: r.approvalRequest.lockVersion,
      confirm: { roundNo: r.roundNo, accountUid: r.channelAccount.accountUid },
      accountType: "none",
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      ...(await checks("account.verify")),
    };
  }
  async function launchBody(id: string, count: number): Promise<LaunchApproveBody> {
    const r = await prisma.launchSubmission.findUniqueOrThrow({
      where: { id },
      include: { approvalRequest: true },
    });
    return {
      lockVersion: r.approvalRequest.lockVersion,
      confirm: { roundNo: r.roundNo, reportedEpisodeCount: r.reportedEpisodeCount },
      verifiedEpisodeCount: count,
      ...(await checks("launch.verify")),
    };
  }
  async function account(viewer: PublishViewer, platform: "douyin" | "wechat_channels" = "douyin") {
    const file = await screenshot(viewer),
      card = await publish.bind(viewer, {
        platform,
        accountName: "测试号",
        accountUid: `LYX${uuidv7()}`,
        accountType: "none",
        screenshotFileIds: [file.id],
      });
    const round = await prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: card.channelAccountId },
    });
    const admin = await staff();
    await publish.approveAccount(admin.ctx, admin.staff, round.id, await approveBody(round.id));
    return card.channelAccountId;
  }
  async function tasks(viewer: PublishViewer, accounts: string[]) {
    const order = await make.dramaOrder({
        entityId: viewer.membership.entityId,
        storeId: viewer.membership.storeId,
        status: "to_launch",
      }),
      item = await make.orderItem({
        dramaOrderId: order.id,
        phase: "to_launch",
        agreedLaunchDate: new Date("2026-01-07"),
      }),
      ticket = await make.deliveryTicket({
        orderItemId: item.id,
        step: "awaiting_launch",
        deliveredAt: new Date("2026-01-01T16:00:00Z"),
      });
    for (const id of accounts)
      await prisma.orderItemAccount.create({
        data: {
          orderItemId: item.id,
          channelAccountId: id,
          platform: (await prisma.channelAccount.findUniqueOrThrow({ where: { id } })).platform,
          createdAt: clock.now(),
        },
      });
    const input = {
      orderItemId: item.id,
      deliveryTicketId: ticket.id,
      channelAccountIds: accounts,
    };
    const ids = await tx.run((t) => publish.createLaunchTasks(t, viewer.ctx, input));
    return { ids, item, ticket, order, input };
  }
  return {
    prisma,
    clock,
    tx,
    make,
    assembly,
    media,
    approval,
    publish,
    owner,
    screenshot,
    staff,
    checks,
    approveBody,
    launchBody,
    account,
    tasks,
    changes,
    unbind,
  };
}
export type Harness = ReturnType<typeof harness>;
