import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { findI20Violations, revokePortalGrants } from "./index.js";
import { buildHarness, META } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { authorizedPortal, portalOwner, portalStack } from "./__fixtures__/portal.js";

const db = useSeededDatabase("services", { label: "portalsess" });
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);
const tables = [
  "portal_ticket",
  "portal_session",
  "merchant_user",
  "entity_member",
  "store",
  "auth_event",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
describe("只读会话、精准撤销与真实不变量", () => {
  it("创建/确认/交换产生合法会话，所有GET与鉴权只读、只存摘要、固定scope与能力", async () => {
    const owner = await portalOwner(h);
    const world = await authorizedPortal(h, owner);
    const row = await h.prisma.portalSession.findUniqueOrThrow({
      where: { id: world.session.portalSessionId },
    });
    expect(row.tokenHash).toHaveLength(32);
    expect(Buffer.from(row.tokenHash).toString()).not.toContain(world.token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7_200_000);
    const before = await snapshotTables(h.prisma, tables);
    const principal = await world.sessions.authenticate(world.token);
    expect(principal).toMatchObject({
      merchantUserId: owner.principal.merchantUserId,
      entityId: owner.ctx.entityId,
      storeId: owner.ctx.storeId,
    });
    expect(principal.view.capabilities).toEqual(["delivery.download", "sample.view", "ad.view"]);
    expect((await world.sessions.list(owner)).items).toHaveLength(1);
    expect(
      (await world.tickets.poll(world.ticket.portalTicketId, world.ticket.pollSecret)).status,
    ).toBe("consumed");
    expect(await h.tx.run((tx) => findI20Violations(tx, h.clock.now()))).toEqual([]);
    expect(await portalStack(h).checkTickets()).toEqual([]);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    const text = JSON.stringify(
      await h.prisma.authEvent.findMany({ where: { subjectId: owner.principal.merchantUserId } }),
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(text).not.toContain(world.token);
    expect(text).not.toContain(world.ticket.pollSecret);
    const pending = await world.tickets.create(META);
    const snapshots = await snapshotTables(h.prisma, tables);
    const code = pending.shortCode.toLowerCase().replace(/^(.{4})/, "$1- ");
    const preview = await world.tickets.lookup(owner, code);
    expect(preview.pairChoices).toHaveLength(3);
    expect(new Set(preview.pairChoices).size).toBe(3);
    expect(preview.pairChoices).toContain(pending.pairDigits);
    expect(
      await world.tickets.lookup(owner, new URL(pending.qrUrl).searchParams.get("t")!),
    ).toEqual(preview);
    assertSnapshotsEqual(snapshots, await snapshotTables(h.prisma, tables));
  });
  it("门店archived仍可授权和使用；跨主体不能列出或撤销他人的会话", async () => {
    const owner = await portalOwner(h);
    const other = await portalOwner(h);
    const world = await authorizedPortal(h, owner);
    // Legal historical archived store fixture, not a fabricated portal success.
    const archived = await h.make.store({
      entityId: owner.ctx.entityId!,
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: owner.principal.merchantUserId,
      archiveClient: "weapp",
    });
    const archivedOwner = {
      ...owner,
      ctx: createIdentityContext({ ...owner.ctx, storeId: archived.id }),
    };
    const archivedWorld = await authorizedPortal(h, archivedOwner);
    expect(
      (await archivedWorld.sessions.authenticate(archivedWorld.token)).view.isStoreArchived,
    ).toBe(true);
    expect((await world.sessions.list(other)).items).toEqual([]);
    await expect(world.sessions.revoke(other, world.session.portalSessionId)).rejects.toMatchObject(
      { error: "NOT_FOUND" },
    );
    expect((await world.sessions.authenticate(world.token)).storeId).toBe(owner.ctx.storeId);
  });
  it("撤销只影响指定会话且保留首次证据；已过期不补写，退出写一次事件", async () => {
    const owner = await portalOwner(h);
    const a = await authorizedPortal(h, owner);
    const b = await authorizedPortal(h, owner);
    const result = await a.sessions.revoke(owner, a.session.portalSessionId);
    expect(result.revokedAt).toBe(h.clock.now().toISOString());
    await expect(a.sessions.authenticate(a.token)).rejects.toMatchObject({
      details: { reason: "revoked", revokeReason: "owner_revoked" },
    });
    await b.sessions.authenticate(b.token);
    const before = await snapshotTables(h.prisma, tables);
    h.clock.advance(1000);
    expect(await a.sessions.revoke(owner, a.session.portalSessionId)).toEqual(result);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    const principal = await b.sessions.authenticate(b.token);
    await b.sessions.logout(principal, META);
    expect(
      await h.prisma.authEvent.count({
        where: {
          space: "portal",
          event: "logout",
          detail: { path: ["sessionId"], equals: principal.sessionId },
        },
      }),
    ).toBe(1);
    const c = await authorizedPortal(h, owner);
    h.clock.advance(7_200_000);
    const expiredBefore = await snapshotTables(h.prisma, tables);
    await expect(c.sessions.authenticate(c.token)).rejects.toMatchObject({
      details: { reason: "expired" },
    });
    expect((await c.sessions.revoke(owner, c.session.portalSessionId)).revokedAt).toBeNull();
    assertSnapshotsEqual(expiredBefore, await snapshotTables(h.prisma, tables));
  });
  it("授权人资格即时读校验，I20检出真实违规；读取不替吊销端口修复", async () => {
    const owner = await portalOwner(h);
    const world = await authorizedPortal(h, owner);
    const member = await h.prisma.entityMember.findFirstOrThrow({
      where: {
        merchantUserId: owner.principal.merchantUserId,
        entityId: owner.ctx.entityId!,
        status: "active",
      },
    });
    // Fault injection models a missed historical revocation, then exercises real detection.
    await h.prisma.entityMember.update({ where: { id: member.id }, data: { role: "clerk" } });
    const before = await snapshotTables(h.prisma, tables);
    await expect(world.sessions.authenticate(world.token)).rejects.toMatchObject({
      details: { reason: "authorizer_invalid", revokeReason: null },
    });
    expect(await h.tx.run((tx) => findI20Violations(tx, h.clock.now()))).toContainEqual({
      subject: { type: "portal_session", id: world.session.portalSessionId },
      entityId: owner.ctx.entityId,
      detail: { reason: "authorizer_invalid" },
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    await h.tx.run(async (tx) => {
      await lockRows(tx, "entity", [owner.ctx.entityId!]);
      await lockRows(tx, "entity_member", [member.id]);
      expect(
        await revokePortalGrants(tx, {
          scope: "owner",
          entityId: owner.ctx.entityId!,
          merchantUserId: owner.principal.merchantUserId,
          now: h.clock.now(),
        }),
      ).toBe(1);
    });
    await expect(world.sessions.authenticate(world.token)).rejects.toMatchObject({
      details: { reason: "revoked", revokeReason: "membership_changed" },
    });
    expect(await h.tx.run((tx) => findI20Violations(tx, h.clock.now()))).toEqual([]);
  });
  it("账号disabled同样立即拒绝，门户cookie不可复用为商家Bearer或冒充另一store", async () => {
    const owner = await portalOwner(h);
    const world = await authorizedPortal(h, owner);
    expect((await h.identity.authenticate(world.token, { ip: META.ip })).ok).toBe(false);
    await expect(
      h.prisma.portalSession.update({
        where: { id: world.session.portalSessionId },
        data: { storeId: uuidv7() },
      }),
    ).rejects.toBeDefined();
    await h.prisma.merchantUser.update({
      where: { id: owner.principal.merchantUserId },
      data: { status: "disabled" },
    });
    const before = await snapshotTables(h.prisma, tables);
    await expect(world.sessions.authenticate(world.token)).rejects.toMatchObject({
      details: { reason: "authorizer_invalid" },
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("I31检出真实缺失会话；票据仅7天后清理，不影响存活/过期会话留存", async () => {
    const owner = await portalOwner(h);
    const world = await authorizedPortal(h, owner);
    // Deliberate corruption to prove the invariant is not a constant-success registration.
    await h.prisma.portalSession.delete({ where: { id: world.session.portalSessionId } });
    expect(await portalStack(h).checkTickets()).toContainEqual({
      subject: { type: "portal_ticket", id: world.ticket.portalTicketId },
      entityId: owner.ctx.entityId,
      detail: { sessions: 0 },
    });
    const surviving = await authorizedPortal(h, owner);
    const sessionBefore = await h.prisma.portalSession.findUniqueOrThrow({
      where: { id: surviving.session.portalSessionId },
    });
    h.clock.advance(7 * 86_400_000 + 1);
    expect(await portalStack(h).purgeTickets(1000)).toBeGreaterThan(0);
    expect(
      await h.prisma.portalTicket.findUnique({ where: { id: surviving.ticket.portalTicketId } }),
    ).toBeNull();
    expect(
      await h.prisma.portalSession.findUniqueOrThrow({
        where: { id: surviving.session.portalSessionId },
      }),
    ).toEqual(sessionBefore);
    expect(await portalStack(h).checkTickets()).toEqual([]);
  });
});
