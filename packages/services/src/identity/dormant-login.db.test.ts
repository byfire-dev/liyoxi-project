import { maskName } from "@liyoxi/shared/mask";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Assembly } from "../kernel/index.js";
import { billingHistoryPort, createTenant } from "../tenant/index.js";
import { assembleForTest, diffSnapshots, useSeededDatabase } from "../testing/index.js";
import { buildHarness, META, nextOpenid, nextPhone } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { DAY, dormantState, dormantWorld, portalGrant } from "./__fixtures__/dormant-login.js";
import type { DormantWorld } from "./__fixtures__/dormant-login.js";

const db = useSeededDatabase("services", { label: "dormantlogin", max: 1 });
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);
afterEach(() => {
  vi.restoreAllMocks();
  h.dormantDays = 180;
});
const login = (phone: string, consents = h.consents()) =>
  h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: nextOpenid() }),
    consents,
  });
async function settled(w: DormantWorld) {
  expect(await h.tenant.activeMembership(h.prisma, w.user.id)).toBeNull();
  const consents = await h.prisma.agreementConsent.findMany({
    where: { merchantUserId: w.user.id },
  });
  expect(consents).toHaveLength(2);
  for (const consent of consents)
    expect(consent).toMatchObject({ role: null, operatorNameMask: maskName("账号称呼") });
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: w.user.id, eventType: "merchant_user.wechat_bound" },
    }),
  ).toBe(0);
  expect(
    await h.prisma.auditLog.count({
      where: { targetId: w.user.id, action: "identity.wechat_identity.bind" },
    }),
  ).toBe(0);
  expect(
    await h.prisma.wechatIdentity.findUniqueOrThrow({ where: { id: w.oldIdentity.id } }),
  ).toEqual(w.oldIdentity);
  expect(await h.identity.authenticate(w.oldSession.token, { ip: null })).toMatchObject({
    ok: true,
  });
}

describe("W2-09 休眠登录同事务处置", { timeout: 120_000 }, () => {
  it("休眠店员移除全部门店关系、清空关系名后绑定，签名与通知读取新关系", async () => {
    const w = await dormantWorld(h, "clerk"),
      second = await h.make.store({ entityId: w.entity.id });
    await h.make.storeMember({
      entityId: w.entity.id,
      entityMemberId: w.member.id,
      storeId: second.id,
    });
    const beforeRuns = h.txRuns(),
      result = await login(w.phone);
    expect(h.txRuns() - beforeRuns).toBe(1);
    expect(result.me.memberships).toEqual([]);
    expect(result.isNewUser).toBe(false);
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
    ).toMatchObject({
      status: "removed",
      displayName: null,
      removeReason: "dormant",
      removeActorType: "system",
      removeActorId: null,
      removeClient: null,
      lastStoreId: null,
    });
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: w.member.id } })).toBe(0);
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toEqual(
      w.entity,
    );
    expect(
      await h.prisma.statusTransition.findMany({ where: { subjectId: w.member.id } }),
    ).toMatchObject([
      { event: "entity_member.cascade_remove", actorType: "system", actorId: null },
    ]);
    expect(
      await h.prisma.outboxEvent.findMany({ where: { aggregateId: w.member.id } }),
    ).toMatchObject([{ eventType: "entity_member.removed", payload: { removeReason: "dormant" } }]);
    await settled(w);
  });

  it("休眠空草稿老板让位并精准吊销portal，门店/成员系统级联后继续绑定", async () => {
    const w = await dormantWorld(h, "owner"),
      second = await h.make.store({ entityId: w.entity.id });
    const own = await portalGrant(h, w),
      other = await portalGrant(h, w, (await h.make.merchantUser()).id);
    const beforeRuns = h.txRuns(),
      result = await login(w.phone);
    expect(h.txRuns() - beforeRuns).toBe(1);
    expect(result.me.memberships).toEqual([]);
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toMatchObject({
      lifecycle: "abandoned",
      closedAt: h.clock.now(),
    });
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
    ).toMatchObject({
      status: "removed",
      removeReason: "draft_abandoned",
      removeActorType: "system",
      removeActorId: null,
      removeClient: null,
    });
    for (const storeId of [w.store.id, second.id])
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id: storeId } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "entity_abandoned",
        archiveActorType: "system",
        archiveActorId: null,
        archiveClient: null,
      });
    expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject(
      { revokedAt: h.clock.now(), revokeReason: "membership_changed" },
    );
    expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: other.id } })).toEqual(
      other,
    );
    expect(await h.prisma.outboxEvent.findMany({ where: { entityId: w.entity.id } })).toHaveLength(
      4,
    );
    await settled(w);
  });

  it.each(["new", "no_membership", "bypass", "recent", "off"] as const)(
    "五条放行条件 %s 维持原登录，不做休眠处置",
    async (mode) => {
      let phone: string, w: DormantWorld | undefined;
      if (mode === "new") phone = nextPhone();
      else if (mode === "no_membership") {
        phone = nextPhone();
        await h.make.merchantUser({
          phone,
          lastActiveAt: new Date(h.clock.now().getTime() - 181 * DAY),
        });
      } else {
        w = await dormantWorld(h, "owner", true);
        phone = w.phone;
        if (mode === "bypass")
          await h.prisma.merchantUser.update({
            where: { id: w.user.id },
            data: { dormantBypassUntil: new Date(h.clock.now().getTime() + 1) },
          });
        if (mode === "recent")
          await h.prisma.merchantUser.update({
            where: { id: w.user.id },
            data: { lastActiveAt: new Date(h.clock.now().getTime() - 180 * DAY) },
          });
        if (mode === "off") h.dormantDays = 0;
      }
      const remove = vi.spyOn(h.tenant, "removeMemberIn"),
        abandon = vi.spyOn(h.tenant, "abandonDraftIn");
      const result = await login(phone);
      expect(result.isNewUser).toBe(mode === "new");
      expect(remove).not.toHaveBeenCalled();
      expect(abandon).not.toHaveBeenCalled();
      if (w) {
        expect(
          await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
        ).toEqual(w.member);
        expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toEqual(
          w.entity,
        );
        expect(result.me.memberships).toHaveLength(1);
      } else expect(result.me.memberships).toEqual([]);
    },
  );

  it.each(["verified", "pending"] as const)(
    "非空老板 %s 回滚登录，仅独立记录人工重验",
    async (mode) => {
      const w = await dormantWorld(h, "owner", mode === "verified");
      if (mode === "pending")
        await h.prisma.invitation.create({
          data: {
            id: uuidv7(),
            entityId: w.entity.id,
            storeId: w.store.id,
            inviterMemberId: w.member.id,
            role: "clerk",
            status: "pending",
            tokenEnc: "lyxtest historical opaque invitation",
            tokenHash: Buffer.alloc(32, 31),
            clientRequestId: uuidv7(),
            expiresAt: new Date(h.clock.now().getTime() + DAY),
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
      const before = await dormantState(h),
        beforeRuns = h.txRuns();
      await expect(login(w.phone)).rejects.toMatchObject({ error: "REVERIFY_REQUIRED" });
      expect(h.txRuns() - beforeRuns).toBe(2);
      const diff = diffSnapshots(before, await dormantState(h));
      expect(diff.tables.map((t) => t.table)).toEqual(["auth_event"]);
      expect(diff.tables[0]).toMatchObject({ changed: [], removed: [] });
      expect(diff.tables[0]!.added).toHaveLength(1);
      expect(await h.prisma.authEvent.findMany({ where: { subjectId: w.user.id } })).toMatchObject([
        { event: "reverify_required", method: "phone" },
      ]);
    },
  );

  it.each(["clerk", "owner"] as const)(
    "%s 处置后同意版本失败，级联、portal、身份与会话全部回滚",
    async (role) => {
      const w = await dormantWorld(h, role);
      await portalGrant(h, w);
      const before = await dormantState(h);
      await expect(
        login(w.phone, [{ agreementKey: "user", agreementVersionId: uuidv7() }]),
      ).rejects.toMatchObject({ error: "AGREEMENT_VERSION_STALE" });
      expect(await dormantState(h)).toEqual(before);
    },
  );

  it("真实历史事实依赖读后抛同符号业务异常，原样传播且不伪装人工重验", async () => {
    const w = await dormantWorld(h, "owner"),
      base = assembleForTest({ entry: "api" });
    const failure = new AppError("STATE_NOT_ALLOWED"),
      real = base.port(billingHistoryPort);
    let reads = 0;
    const assembly: Assembly = {
      ...base,
      port: ((key) =>
        key === billingHistoryPort
          ? {
              read: async (...args: Parameters<typeof real.read>) => {
                await real.read(...args);
                reads++;
                throw failure;
              },
            }
          : base.port(key)) as Assembly["port"],
    };
    const events = createEvents({ assembly, clock: h.clock, tx: h.tx });
    const tenant = createTenant({
      tx: h.tx,
      clock: h.clock,
      assembly,
      flow: createFlow({ assembly, clock: h.clock, events }),
    });
    vi.spyOn(h.tenant, "abandonDraftIn").mockImplementation((...args) =>
      tenant.abandonDraftIn(...args),
    );
    const before = await dormantState(h),
      beforeRuns = h.txRuns();
    await expect(login(w.phone)).rejects.toBe(failure);
    expect(reads).toBe(1);
    expect(h.txRuns() - beforeRuns).toBe(1);
    expect(await dormantState(h)).toEqual(before);
  });
});
