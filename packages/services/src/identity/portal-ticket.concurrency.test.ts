import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { buildHarness, barrier, META, openClient } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { authorizedPortal, portalOwner, portalStack } from "./__fixtures__/portal.js";
import type { PortalOwnerRequest } from "./index.js";
import { newPortalSecret, portalSecretHash, portalSecretMatches } from "./index.js";

const db = useSeededDatabase("services", { label: "portalticket" });
let h: Harness;
let owners: PortalOwnerRequest[];
let clients: PrismaClient[] = [];
let runners: TxRunner[];
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  owners = [await portalOwner(h), await portalOwner(h)];
  clients = [await openClient(db), await openClient(db)];
  runners = clients.map((prisma) => createTxRunner({ prisma, appEnv: "test" }));
}, 120_000);
afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});
function raceStacks() {
  const ready = barrier(2);
  return runners.map((runner) =>
    portalStack(h, {
      run: (fn, options) =>
        runner.run(async (tx) => {
          await ready();
          return fn(tx);
        }, options),
    }),
  );
}
const facts = [
  "portal_ticket",
  "portal_session",
  "auth_event",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
describe("portal票据：真实数据库一次性", () => {
  it("令牌性质反例：32字节随机文本、摘要固定32字节，每个位置单字变更均拒绝", () => {
    const tokens = new Set<string>();
    for (let round = 0; round < 5; round++) {
      const token = newPortalSecret();
      tokens.add(token);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      const hash = portalSecretHash(token);
      expect(hash).toHaveLength(32);
      expect(portalSecretMatches(token, hash)).toBe(true);
      for (let i = 0; i < token.length; i++) {
        const altered = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
        expect(portalSecretMatches(altered, hash)).toBe(false);
      }
    }
    expect(tokens.size).toBe(5);
  });
  it("两独立连接5轮：不同主体老板并发确认只产生一份授权，同票据并发exchange只产生一会话", async () => {
    const pids = await Promise.all(
      clients.map((c) => c.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`),
    );
    expect(new Set(pids.flat().map((row) => row.pid)).size).toBe(2);
    for (let round = 0; round < 5; round++) {
      const ticket = await portalStack(h).tickets.create(META);
      const stacks = raceStacks();
      const decisions = await Promise.allSettled(
        stacks.map((stack, i) =>
          stack.tickets.decide(owners[i]!, ticket.portalTicketId, ticket.pairDigits),
        ),
      );
      expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = decisions.find((r) => r.status === "rejected");
      expect(lost?.status === "rejected" && lost.reason).toMatchObject({
        error: "PORTAL_TICKET_INVALID",
        details: { reason: "approved" },
      });
      const swaps = await Promise.allSettled(
        raceStacks().map((stack) =>
          stack.tickets.exchange(ticket.portalTicketId, ticket.pollSecret, META),
        ),
      );
      expect(swaps.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await h.prisma.portalSession.count({ where: { portalTicketId: ticket.portalTicketId } }),
      ).toBe(1);
      const row = await h.prisma.portalTicket.findUniqueOrThrow({
        where: { id: ticket.portalTicketId },
      });
      const session = await h.prisma.portalSession.findUniqueOrThrow({
        where: { portalTicketId: ticket.portalTicketId },
      });
      expect(row.exchangeAttempts).toBe(1);
      expect(session.approvedByUserId).toBe(row.approvedByUserId);
      expect(session.entityId).toBe(row.entityId);
      expect(session.storeId).toBe(row.storeId);
    }
  }, 90_000);
  it("确认和拒绝竞争只有一个200；错误配对一次作废，拒绝不写确认列", async () => {
    const ticket = await portalStack(h).tickets.create(META);
    const [a, b] = raceStacks();
    const result = await Promise.allSettled([
      a!.tickets.decide(owners[0]!, ticket.portalTicketId, ticket.pairDigits),
      b!.tickets.decide(owners[1]!, ticket.portalTicketId, null),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const mismatch = await portalStack(h).tickets.create(META);
    const wrong = mismatch.pairDigits === "00" ? "01" : "00";
    expect(
      await portalStack(h).tickets.decide(owners[0]!, mismatch.portalTicketId, wrong),
    ).toMatchObject({
      status: "rejected",
      rejectReason: "pair_mismatch",
      approvedAt: null,
      storeId: null,
    });
    expect(
      await h.prisma.portalTicket.findUniqueOrThrow({ where: { id: mismatch.portalTicketId } }),
    ).toMatchObject({ approvedByUserId: null, entityId: null, storeId: null });
  });
  it("pending错误secret/到期/正确secret均不写；已消费优先于secret且旧secret不能换新票据", async () => {
    const { tickets } = portalStack(h);
    const ticket = await tickets.create(META);
    const wrong = randomBytes(32).toString("base64url");
    const before = await snapshotTables(h.prisma, facts);
    await expect(tickets.exchange(ticket.portalTicketId, wrong, META)).rejects.toMatchObject({
      details: { reason: "secret_mismatch" },
    });
    await expect(
      tickets.exchange(ticket.portalTicketId, ticket.pollSecret, META),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    h.clock.advance(120_000);
    await expect(
      tickets.exchange(ticket.portalTicketId, ticket.pollSecret, META),
    ).rejects.toMatchObject({ details: { reason: "expired" } });
    await expect(
      tickets.decide(owners[0]!, ticket.portalTicketId, ticket.pairDigits),
    ).rejects.toMatchObject({ details: { reason: "expired" } });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, facts));
    const fresh = await tickets.create(META);
    await tickets.decide(owners[0]!, fresh.portalTicketId, fresh.pairDigits);
    expect((await tickets.exchange(fresh.portalTicketId, ticket.pollSecret, META)).result).toEqual({
      status: "rejected",
      session: null,
      rejectReason: "secret_mismatch",
    });
    const live = await authorizedPortal(h, owners[0]!);
    await expect(tickets.exchange(live.ticket.portalTicketId, wrong, META)).rejects.toMatchObject({
      details: { reason: "consumed" },
    });
  });
  it("确认60秒边界可交换，超过1ms持久拒绝并记独立login_fail；5次守卫保留", async () => {
    const { tickets } = portalStack(h);
    const exact = await tickets.create(META);
    await tickets.decide(owners[0]!, exact.portalTicketId, exact.pairDigits);
    h.clock.advance(60_000);
    expect(
      (await tickets.exchange(exact.portalTicketId, exact.pollSecret, META)).result.status,
    ).toBe("consumed");
    for (const kind of ["window_passed", "attempts_exceeded"] as const) {
      const ticket = await tickets.create(META);
      await tickets.decide(owners[0]!, ticket.portalTicketId, ticket.pairDigits);
      if (kind === "window_passed") h.clock.advance(60_001);
      else
        await h.prisma.portalTicket.update({
          where: { id: ticket.portalTicketId },
          data: { exchangeAttempts: 5 },
        }); // failure injection, not a success fixture
      expect(
        (await tickets.exchange(ticket.portalTicketId, ticket.pollSecret, META)).result
          .rejectReason,
      ).toBe(kind);
      expect(
        await h.prisma.portalSession.count({ where: { portalTicketId: ticket.portalTicketId } }),
      ).toBe(0);
      expect(
        await h.prisma.authEvent.findFirst({
          where: {
            space: "portal",
            event: "login_fail",
            detail: { path: ["reason"], equals: kind },
          },
        }),
      ).not.toBeNull();
    }
  });
  it("真实票据行锁等待后重取时钟：pending过期不能确认，approved窗口过去不能换会话", async () => {
    for (const approved of [false, true]) {
      const { tickets } = portalStack(h);
      const ticket = await tickets.create(META);
      if (approved) await tickets.decide(owners[0]!, ticket.portalTicketId, ticket.pairDigits);
      let release!: () => void;
      let locked!: () => void;
      const releaseLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = runners[0]!.run(async (tx) => {
        await tx.$queryRaw`SELECT id FROM portal_ticket WHERE id=${ticket.portalTicketId}::uuid FOR UPDATE`;
        locked();
        await releaseLock;
      });
      await hasLock;
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const waiting: TxRunner = {
        run: (fn, options) =>
          runners[1]!.run((tx) => {
            const promise = fn(tx);
            began();
            return promise;
          }, options),
      };
      const stack = portalStack(h, waiting);
      const pending = approved
        ? stack.tickets.exchange(ticket.portalTicketId, ticket.pollSecret, META)
        : stack.tickets.decide(owners[0]!, ticket.portalTicketId, ticket.pairDigits);
      // Attach rejection observation before releasing a transaction.
      const observed = Promise.allSettled([pending]);
      await started;
      h.clock.advance(approved ? 60_001 : 120_000);
      release();
      await holder;
      const [outcome] = await observed;
      if (approved) {
        expect(outcome).toMatchObject({
          status: "fulfilled",
          value: {
            token: null,
            result: { status: "rejected", rejectReason: "window_passed" },
          },
        });
      } else
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: {
            error: "PORTAL_TICKET_INVALID",
            details: { reason: "expired" },
          },
        });
      expect(
        await h.prisma.portalSession.count({ where: { portalTicketId: ticket.portalTicketId } }),
      ).toBe(0);
    }
  });
  it("确认等待票据锁期间商家真实退出，释放锁后旧身份不能继续授权", async () => {
    const owner = await portalOwner(h);
    const ticket = await portalStack(h).tickets.create(META);
    const pids = await Promise.all(
      clients.map((client) => client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`),
    );
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = runners[0]!.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM portal_ticket WHERE id=${ticket.portalTicketId}::uuid FOR UPDATE`;
      entered();
      await waiting;
    });
    await locked;
    const decision = Promise.allSettled([
      portalStack(h, runners[1]!).tickets.decide(owner, ticket.portalTicketId, ticket.pairDigits),
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
      await h.identity.logout(owner.principal, META);
    } finally {
      release();
      await holder;
    }
    expect((await decision)[0]).toMatchObject({
      status: "rejected",
      reason: { error: "SESSION_INVALID" },
    });
    expect(
      await h.prisma.portalTicket.findUniqueOrThrow({ where: { id: ticket.portalTicketId } }),
    ).toMatchObject({
      status: "pending",
      approvedByUserId: null,
      entityId: null,
      storeId: null,
    });
  });
  it("撤销/退出等待会话行锁期间到期，不用等待前的时间补写撤销或事件", async () => {
    for (const logout of [false, true]) {
      const owner = await portalOwner(h);
      const world = await authorizedPortal(h, owner);
      const principal = await world.sessions.authenticate(world.token);
      const before = await h.prisma.portalSession.findUniqueOrThrow({
        where: { id: principal.sessionId },
      });
      const pids = await Promise.all(
        clients.map(
          (client) => client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
        ),
      );
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const holder = runners[0]!.run(async (tx) => {
        await tx.$queryRaw`SELECT id FROM portal_session WHERE id=${principal.sessionId}::uuid FOR UPDATE`;
        entered();
        await waiting;
      });
      await locked;
      const { sessions } = portalStack(h, runners[1]!);
      const decision = Promise.allSettled([
        logout ? sessions.logout(principal, META) : sessions.revoke(owner, principal.sessionId),
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
        h.clock.advance(7_200_000);
      } finally {
        release();
        await holder;
      }
      const [result] = await decision;
      if (logout)
        expect(result).toMatchObject({
          status: "rejected",
          reason: {
            error: "PORTAL_SESSION_INVALID",
            details: { reason: "expired" },
          },
        });
      else expect(result).toMatchObject({ status: "fulfilled", value: { revokedAt: null } });
      expect(
        await h.prisma.portalSession.findUniqueOrThrow({ where: { id: principal.sessionId } }),
      ).toEqual(before);
      expect(
        await h.prisma.authEvent.count({
          where: {
            space: "portal",
            event: "logout",
            detail: { path: ["sessionId"], equals: principal.sessionId },
          },
        }),
      ).toBe(0);
      expect(
        await h.prisma.auditLog.count({
          where: { targetId: principal.sessionId, action: "identity.portal_session.revoke" },
        }),
      ).toBe(0);
    }
  });
});
