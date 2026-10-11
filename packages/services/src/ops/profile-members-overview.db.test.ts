import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implementMerchantFacts,
  uuidv7,
} from "../kernel/index.js";
import type { MerchantFactsQuery, Tx, TxRunner } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { createProfile } from "../profile/index.js";
import type { ProfileViewer } from "../profile/index.js";
import { createInvitationExpiry, createTenant } from "../tenant/index.js";
import { createTimers } from "../timers/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";

const db = useSeededDatabase("services", { max: 1 });
let prisma: Awaited<ReturnType<typeof db.prisma>>;
beforeAll(async () => {
  prisma = await db.prisma();
}, 120_000);
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "store_profile",
  "store_profile_media",
  "store_service_item",
  "qualification_submission",
  "qualification_doc",
  "timer",
  "audit_log",
  "outbox_event",
  "status_transition",
  "idempotency_record",
];

async function world(onFacts?: (tx: Tx, query: MerchantFactsQuery) => void) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_members_overview", {
        portImplementations: [
          implementMerchantFacts("ad", async (handle, query) => {
            onFacts?.(handle, query);
            return {
              stores: Object.fromEntries(
                query.storeIds.map((id) => [
                  id,
                  {
                    pendingConfirmCount: 2,
                    producingCount: 3,
                    readyCount: 4,
                  },
                ]),
              ),
            };
          }),
        ],
      }),
    ],
  });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, events, assembly });
  const tenant = createTenant({ tx, clock, flow, assembly });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const fake = createFakeProviders({ clock });
  const media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  const make = createFactories({ db: prisma, clock });
  const user = await make.merchantUser(),
    entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id, isPrimary: true });
  const member = await make.entityMember({
    entityId: entity.id,
    merchantUserId: user.id,
    role: "owner",
    displayName: "成员老板",
  });
  const viewer: ProfileViewer = {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp" },
      entityId: entity.id,
      storeId: store.id,
    }),
    principal: {
      merchantUserId: user.id,
      sessionId: uuidv7(),
      wechatIdentityId: uuidv7(),
      consentStamp: null,
    },
    membership: {
      memberId: member.id,
      entityId: entity.id,
      storeId: store.id,
      role: "owner",
      storeMode: "active",
    },
  };
  function profile(runner: TxRunner = tx) {
    return createProfile({
      tx: runner,
      clock,
      assembly,
      tenant,
      approval,
      events,
      media: { link: media.link, release: media.release, signRead: media.signRead },
      keyring: () => TEST_KEYRING,
      wechat: fake.wechat,
      currentOpenid: async () => "lyxtest_summary",
    });
  }
  async function invitation(expiresAt: Date) {
    const id = uuidv7();
    return prisma.invitation.create({
      data: {
        id,
        entityId: entity.id,
        storeId: store.id,
        inviterMemberId: member.id,
        role: "clerk",
        status: "pending",
        clientRequestId: uuidv7(),
        tokenHash: createHash("sha256").update(id).digest(),
        tokenEnc: null,
        createdAt: new Date(clock.now().getTime() - 7_200_000),
        updatedAt: clock.now(),
        expiresAt,
      },
    });
  }
  return {
    clock,
    tx,
    assembly,
    events,
    flow,
    tenant,
    make,
    entity,
    store,
    member,
    viewer,
    profile,
    invitation,
  };
}

describe("建档首页真实成员摘要组合", { timeout: 120_000 }, () => {
  it("真实Tenant接入四摘要，其他档案/资格/素材/广告字段保持，缺档案不补行", async () => {
    const h = await world();
    const clerk = await h.make.entityMember({ entityId: h.entity.id, displayName: "本店店员" });
    await h.make.storeMember({
      entityMemberId: clerk.id,
      storeId: h.store.id,
      addedByMemberId: h.member.id,
    });
    await h.invitation(new Date(h.clock.now().getTime() + 1_000));
    const before = await snapshotTables(prisma, TABLES);
    const value = await h.profile().get(h.viewer);
    expect(value.members).toEqual({
      ownerDisplayName: "成员老板",
      clerkCount: 1,
      pendingInvitationCount: 1,
      preview: [
        { displayName: "成员老板", role: "owner" },
        { displayName: "本店店员", role: "clerk" },
      ],
    });
    expect(value).toMatchObject({
      store: { storeId: h.store.id, qualificationStatus: "unsubmitted" },
      completeness: { requiredTotal: 15 },
      qualification: { status: "unsubmitted", submittedAt: null, dueAt: null },
      assets: { total: 0, recent7dCount: 0, recent: [] },
      ads: { confirmedCount: 4, pendingConfirmCount: 2, producingCount: 3, revisingCount: 0 },
    });
    expect(value.steps).toMatchObject({
      media: { doorCount: 0, interiorCount: 0, productCount: 0, promoCount: 0 },
      service: { serviceItemCount: 0, sellingPointCount: 0, hasPromoText: false },
      qualification: { docTypes: [] },
    });
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    expect(await prisma.storeProfile.count({ where: { storeId: h.store.id } })).toBe(0);
  });

  it("同一callerTx和唯一now同时传入既有facts与真实摘要，零嵌套事务/完整成员列表调用", async () => {
    let factsTx: Tx | undefined, factsNow: Date | undefined;
    const h = await world((tx, query) => {
      factsTx = tx;
      factsNow = query.now;
      h.clock.advance(1);
    });
    const now = h.clock.now();
    await h.invitation(new Date(now.getTime() + 1));
    const read = vi.spyOn(h.tenant, "readStoreMembersBrief"),
      list = vi.spyOn(h.tenant, "listMembers");
    let actualTx: Tx | undefined;
    let runCount = 0;
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          runCount++;
          actualTx = tx;
          return fn(tx);
        }, options),
    };
    const value = await h.profile(runner).get(h.viewer);
    expect(runCount).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe(actualTx);
    expect(factsTx).toBe(actualTx);
    expect(read.mock.calls[0]![1].now).toBe(factsNow);
    expect(factsNow).toEqual(now);
    expect(value.members.pendingInvitationCount).toBe(1);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1])("迟到expiry状态尚pending %dms时首页只读排除到期", async (offset) => {
    const h = await world();
    const invitation = await h.invitation(new Date(h.clock.now().getTime() + offset));
    const before = await snapshotTables(prisma, TABLES);
    expect((await h.profile().get(h.viewer)).members.pendingInvitationCount).toBe(
      offset > 0 ? 1 : 0,
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe("pending");
  });

  it("真实I30补过期迁移前后首页摘要一致且GET没有旁写", async () => {
    const h = await world();
    const invitation = await h.invitation(new Date(h.clock.now().getTime() - 3_600_001));
    const initial = await h.profile().get(h.viewer);
    const expiry = createInvitationExpiry({
      clock: h.clock,
      flow: h.flow,
      timers: createTimers({ assembly: h.assembly }),
    });
    expect(
      await h.tx.run((tx) => expiry.checkI30(tx, { entityIds: [h.entity.id] }, h.clock.now())),
    ).toHaveLength(1);
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe("expired");
    const afterHeal = await snapshotTables(prisma, TABLES);
    expect((await h.profile().get(h.viewer)).members).toEqual(initial.members);
    expect(await snapshotTables(prisma, TABLES)).toEqual(afterHeal);
  });

  it("真实未提交范围与邀请同Tx可见，完整overview外层失败回滚所有事实", async () => {
    const h = await world();
    const pending = await h.invitation(new Date(h.clock.now().getTime() + 1_000));
    const before = await snapshotTables(prisma, TABLES);
    const failure = new Error("完整overview外层回滚");
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const make = createFactories({ db: tx, clock: h.clock });
          const clerk = await make.entityMember({
            entityId: h.entity.id,
            displayName: "事务内店员",
          });
          await make.storeMember({
            entityMemberId: clerk.id,
            storeId: h.store.id,
            addedByMemberId: h.member.id,
          });
          await tx.invitation.update({
            where: { id: pending.id },
            data: { expiresAt: h.clock.now() },
          });
          const value = await fn(tx);
          expect(value).toMatchObject({
            members: {
              clerkCount: 1,
              pendingInvitationCount: 0,
              preview: [
                { displayName: "成员老板", role: "owner" },
                { displayName: "事务内店员", role: "clerk" },
              ],
            },
          });
          throw failure;
        }, options),
    };
    await expect(h.profile(runner).get(h.viewer)).rejects.toBe(failure);
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    expect((await h.profile().get(h.viewer)).members).toMatchObject({
      clerkCount: 0,
      pendingInvitationCount: 1,
    });
  });

  it("合法by_owner归档保留老板首页，读操作不恢复关系或写入事实", async () => {
    const h = await world();
    await prisma.store.update({
      where: { id: h.store.id },
      data: {
        lifecycle: "archived",
        archiveReason: "by_owner",
        archivedAt: h.clock.now(),
        archiveActorType: "system",
      },
    });
    const before = await snapshotTables(prisma, TABLES);
    expect(
      (
        await h.profile().get({
          ...h.viewer,
          membership: { ...h.viewer.membership, storeMode: "archived" },
        })
      ).members,
    ).toEqual({
      ownerDisplayName: "成员老板",
      clerkCount: 0,
      pendingInvitationCount: 0,
      preview: [{ displayName: "成员老板", role: "owner" }],
    });
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });

  it.each(["draft_deleted", "entity_closed", "entity_abandoned", "entity"])(
    "%s失效关闭，不能把未知范围默认四项零",
    async (mode) => {
      const h = await world();
      if (mode !== "entity")
        await prisma.store.update({
          where: { id: h.store.id },
          data: {
            lifecycle: "archived",
            archiveReason: mode,
            archivedAt: h.clock.now(),
            archiveActorType: "system",
          },
        });
      else
        await prisma.entity.update({
          where: { id: h.entity.id },
          data: { lifecycle: "closed", closedAt: h.clock.now() },
        });
      const before = await snapshotTables(prisma, TABLES);
      await expect(h.profile().get(h.viewer)).rejects.toMatchObject({ error: "NOT_FOUND" });
      expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    },
  );

  it("摘要数据库失败原样传播，原GET不写档案或返回假空摘要", async () => {
    const h = await world(),
      failure = new Error("摘要查询失败");
    vi.spyOn(h.tenant, "readStoreMembersBrief").mockRejectedValueOnce(failure);
    const before = await snapshotTables(prisma, TABLES);
    await expect(h.profile().get(h.viewer)).rejects.toBe(failure);
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
});
