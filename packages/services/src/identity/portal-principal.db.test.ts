import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { assertPortalPrincipal } from "./index.js";
import { buildHarness, META, openClient } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { authorizedPortal, portalOwner, portalStack } from "./__fixtures__/portal.js";

const db = useSeededDatabase("services", { label: "portalcheck" });
let h: Harness,
  clients: PrismaClient[] = [],
  runners: TxRunner[];
const tables = [
  "portal_session",
  "merchant_user",
  "entity",
  "entity_member",
  "store",
  "auth_event",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  clients = [await openClient(db), await openClient(db)];
  runners = clients.map((prisma) => createTxRunner({ prisma, appEnv: "test" }));
}, 120_000);
afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("Portal原生主体在业务边界复核", () => {
  it("返回当前canonical view，不信任旧view；读路径与成功写复核都不产生行变更", async () => {
    const world = await authorizedPortal(h, await portalOwner(h)),
      principal = await world.sessions.authenticate(world.token),
      before = await snapshotTables(h.prisma, tables);
    const stale = {
      ...principal,
      view: { ...principal.view, storeName: "不可信显示快照", capabilities: [] },
    };
    for (const write of [false, true]) {
      expect(
        await h.tx.run((tx) => assertPortalPrincipal(tx, stale, h.clock.now(), { write })),
      ).toEqual(principal);
    }
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("会话、授权人、主体和门店四字段必须与数据库一致，错误id不进入SQL强转", async () => {
    const world = await authorizedPortal(h, await portalOwner(h)),
      principal = await world.sessions.authenticate(world.token),
      before = await snapshotTables(h.prisma, tables);
    for (const field of ["sessionId", "merchantUserId", "entityId", "storeId"] as const)
      for (const write of [false, true])
        await expect(
          h.tx.run((tx) =>
            assertPortalPrincipal(tx, { ...principal, [field]: uuidv7() }, h.clock.now(), {
              write,
            }),
          ),
        ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID" });
    await expect(
      h.tx.run((tx) =>
        assertPortalPrincipal(tx, { ...principal, sessionId: "invalid" }, h.clock.now()),
      ),
    ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID", details: { reason: "not_found" } });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("不把原会话未检查的entity.lifecycle悄悄加入复核守卫", async () => {
    const world = await authorizedPortal(h, await portalOwner(h)),
      principal = await world.sessions.authenticate(world.token);
    // 历史失配输入，仅钉住原认证语义；正式主体关闭仍由原writer负责吊销授权。
    await h.prisma.entity.update({
      where: { id: principal.entityId },
      data: {
        lifecycle: "closed",
        closedAt: h.clock.now(),
      },
    });
    const canonical = await world.sessions.authenticate(world.token),
      before = await snapshotTables(h.prisma, tables);
    for (const write of [false, true])
      expect(
        await h.tx.run((tx) => assertPortalPrincipal(tx, principal, h.clock.now(), { write })),
      ).toEqual(canonical);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("原认证后撤销，下一边界拒绝旧principal且不覆盖撤销证据", async () => {
    const owner = await portalOwner(h),
      world = await authorizedPortal(h, owner),
      principal = await world.sessions.authenticate(world.token);
    await world.sessions.revoke(owner, principal.sessionId);
    const before = await snapshotTables(h.prisma, tables);
    for (const write of [false, true])
      await expect(
        h.tx.run((tx) => assertPortalPrincipal(tx, principal, h.clock.now(), { write })),
      ).rejects.toMatchObject({
        error: "PORTAL_SESSION_INVALID",
        details: { reason: "revoked", revokeReason: "owner_revoked" },
      });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it.each(["owner", "account", "expiry"] as const)("%s资格失效立即拒绝且不自愈", async (kind) => {
    const owner = await portalOwner(h),
      world = await authorizedPortal(h, owner),
      principal = await world.sessions.authenticate(world.token);
    // 仅注入遗漏吊销的历史故障；本测试不把直接改行当作成员/账号生产写路径。
    if (kind === "owner") {
      const member = await h.prisma.entityMember.findFirstOrThrow({
        where: {
          merchantUserId: principal.merchantUserId,
          entityId: principal.entityId,
          status: "active",
        },
      });
      await h.prisma.entityMember.update({ where: { id: member.id }, data: { role: "clerk" } });
    } else if (kind === "account")
      await h.prisma.merchantUser.update({
        where: { id: principal.merchantUserId },
        data: { status: "disabled" },
      });
    const now = kind === "expiry" ? new Date(principal.view.expiresAt) : h.clock.now(),
      before = await snapshotTables(h.prisma, tables);
    for (const write of [false, true])
      await expect(
        h.tx.run((tx) => assertPortalPrincipal(tx, principal, now, { write })),
      ).rejects.toMatchObject({
        error: "PORTAL_SESSION_INVALID",
        details: { reason: kind === "expiry" ? "expired" : "authorizer_invalid" },
      });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it.each(["logout", "owner"] as const)(
    "写复核持锁至业务事务结束，%s不能穿过确认边界",
    async (kind) => {
      const owner = await portalOwner(h),
        world = await authorizedPortal(h, owner),
        principal = await world.sessions.authenticate(world.token),
        member = await h.prisma.entityMember.findFirstOrThrow({
          where: {
            merchantUserId: principal.merchantUserId,
            entityId: principal.entityId,
            status: "active",
          },
        });
      const pids = await Promise.all(
        clients.map(
          (client) => client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
        ),
      );
      expect(pids[0]![0]!.pid).not.toBe(pids[1]![0]!.pid);
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
          release = resolve;
        }),
        locked = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const holder = runners[0]!.run(async (tx) => {
        await assertPortalPrincipal(tx, principal, h.clock.now(), { write: true });
        entered();
        await waiting;
      });
      await locked;
      const mutation = Promise.allSettled([
        kind === "logout"
          ? portalStack(h, runners[1]!).sessions.logout(principal, META)
          : runners[1]!.run((tx) =>
              tx.entityMember.update({ where: { id: member.id }, data: { role: "clerk" } }),
            ),
      ]);
      try {
        let blocked = false;
        const deadline = Date.now() + 2000;
        do {
          const [fact] = await h.prisma.$queryRaw<{ blocked: boolean }[]>`
          SELECT ${pids[0]![0]!.pid}::int=ANY(pg_blocking_pids(${pids[1]![0]!.pid}::int)) AS blocked`;
          if (fact?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        } while (Date.now() < deadline);
        expect(blocked).toBe(true);
      } finally {
        release();
        await holder;
      }
      expect((await mutation)[0]?.status).toBe("fulfilled");
      await expect(
        h.tx.run((tx) => assertPortalPrincipal(tx, principal, h.clock.now(), { write: true })),
      ).rejects.toMatchObject({
        error: "PORTAL_SESSION_INVALID",
        details: { reason: kind === "logout" ? "revoked" : "authorizer_invalid" },
      });
    },
  );
});
