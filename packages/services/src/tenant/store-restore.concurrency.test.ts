import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppError, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { archiveAcceptWorld } from "./__fixtures__/store-archive.js";
import {
  archiveServices,
  memberContext,
  restoreHarness,
  restoreIdem,
  SLOW,
} from "./__fixtures__/store-restore.js";
import type { RestoreHarness } from "./__fixtures__/store-restore.js";

const db = useSeededDatabase("services");
let h: RestoreHarness;
let clients: PrismaClient[];
let sides: ReturnType<typeof archiveServices>[];
let pids: number[];
async function pid(client: PrismaClient) {
  const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (!row) throw new Error("真实连接没有 backend PID");
  return row.pid;
}
beforeAll(async () => {
  const url = await db.url();
  clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  h = restoreHarness(clients[0]!);
  sides = clients.map((client) => archiveServices(client, h.clock));
  pids = await Promise.all(clients.map(pid));
  expect(new Set(pids).size).toBe(2);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);
type Observer = Awaited<ReturnType<typeof connectTestDatabase>>;
async function blocked(observer: Observer, waiter: number, holder: number) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("未观察到两个已知业务 backend 的真实阻塞");
}
function errorOf(result: PromiseSettledResult<unknown> | undefined) {
  expect(result?.status).toBe("rejected");
  const error: unknown = result?.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}
function paused(side: number, failure?: Error) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TxRunner = {
    run: (fn, options) =>
      sides[side]!.tx.run(async (tx) => {
        const value = await fn(tx);
        enter();
        await gate;
        if (failure) throw failure;
        return value;
      }, options),
  };
  return { service: archiveServices(clients[side]!, h.clock, runner), entered, release };
}

describe("恢复门店：真实两连接及锁后重读", { timeout: SLOW }, () => {
  it("两家归档店抢最后一个额度，后提交者重算真实用量", async () => {
    const own = await h.archived();
    const third = await h.make.store({ entityId: own.entityId });
    await h.tenant.archiveStore(own.ctx, { storeId: third.id });
    const hold = paused(0),
      observer = await connectTestDatabase(db.name, { role: null });
    const first = Promise.allSettled([
      hold.service.tenant.restoreStore(own.ctx, { storeId: own.secondId }),
    ]);
    let second: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await hold.entered;
      second = Promise.allSettled([sides[1]!.tenant.restoreStore(own.ctx, { storeId: third.id })]);
      await blocked(observer, pids[1]!, pids[0]!);
      hold.release();
      expect((await first)[0]?.status).toBe("fulfilled");
      expect(errorOf((await second)[0])).toBe("STORE_LIMIT_REACHED");
      expect(
        await h.prisma.store.count({ where: { entityId: own.entityId, lifecycle: "active" } }),
      ).toBe(2);
      const trace = await h.trace(own);
      expect(trace.history.filter((row) => row.event === "store.restore")).toHaveLength(1);
      expect(trace.events.filter((row) => row.eventType === "store.restored")).toHaveLength(1);
      expect(trace.audits.filter((row) => row.action === "store.restore")).toHaveLength(1);
    } finally {
      hold.release();
      await first;
      await second;
      await observer.end();
    }
  });

  it.each(["same_key", "different_key", "rollback"] as const)(
    "%s 竞争不重复副作用",
    async (mode) => {
      const own = await h.archived(),
        key = uuidv7(),
        failure = new Error("持锁恢复回滚");
      const hold = paused(0, mode === "rollback" ? failure : undefined);
      const observer = await connectTestDatabase(db.name, { role: null });
      const first = Promise.allSettled([
        hold.service.tenant.restoreStore(
          own.ctx,
          { storeId: own.secondId },
          {
            idem: restoreIdem(own.ctx, own.secondId, key),
          },
        ),
      ]);
      let second: ReturnType<typeof Promise.allSettled> | undefined;
      try {
        await hold.entered;
        second = Promise.allSettled([
          sides[1]!.tenant.restoreStore(
            own.ctx,
            { storeId: own.secondId },
            {
              idem: restoreIdem(own.ctx, own.secondId, mode === "different_key" ? uuidv7() : key),
            },
          ),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        hold.release();
        const [one] = await first,
          [two] = await second;
        if (mode === "rollback") {
          expect(one).toMatchObject({ status: "rejected", reason: failure });
          expect(two?.status).toBe("fulfilled");
        } else {
          expect(one?.status).toBe("fulfilled");
          if (mode === "same_key") expect(two).toEqual(one);
          else expect(errorOf(two)).toBe("STATE_NOT_ALLOWED");
        }
        const trace = await h.trace(own);
        expect(trace.history.filter((row) => row.event === "store.restore")).toHaveLength(1);
        expect(trace.events.filter((row) => row.eventType === "store.restored")).toHaveLength(1);
        expect(
          await h.prisma.idempotencyRecord.count({
            where: { scope: "m.store.restore", actorKey: `merchant:${own.userId}` },
          }),
        ).toBe(1);
      } finally {
        hold.release();
        await first;
        await second;
        await observer.end();
      }
    },
  );

  it.each(["actor", "member", "store", "expiry"] as const)(
    "%s 等待后重读当前事实和时钟",
    async (mode) => {
      const own = await h.archived();
      const term =
        mode === "expiry"
          ? await h.make.subscriptionTerm({ entityId: own.entityId, maxStores: 2 })
          : null;
      if (term)
        await h.prisma.entity.update({
          where: { id: own.entityId },
          data: { storeLimitOverride: null },
        });
      await clients[1]!.$disconnect();
      const holder = await connectTestDatabase(db.name),
        observer = await connectTestDatabase(db.name, { role: null });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const result = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = result.rows[0]!.pid;
        const table =
          mode === "actor" ? "merchant_user" : mode === "member" ? "entity_member" : "store";
        const id = mode === "actor" ? own.userId : mode === "member" ? own.memberId : own.secondId;
        await holder.query(`SELECT id FROM ${table} WHERE id=$1::uuid FOR UPDATE`, [id]);
        pending = sides[0]!.tenant.restoreStore(own.ctx, { storeId: own.secondId });
        const settled = Promise.allSettled([pending]);
        await blocked(observer, pids[0]!, holderPid);
        if (mode === "actor")
          await holder.query("UPDATE merchant_user SET status='disabled' WHERE id=$1::uuid", [
            own.userId,
          ]);
        if (mode === "member") {
          // 合法历史移除前提，仅检验等待后真实权限；不宣称本片提供老板转让入口。
          await holder.query(
            "UPDATE entity_member SET status='removed',removed_at=$2,remove_actor_type='system',remove_actor_id=NULL,remove_client=NULL,remove_reason='owner_transfer',last_store_id=NULL WHERE id=$1::uuid",
            [own.memberId, h.clock.now()],
          );
        }
        if (mode === "store")
          await holder.query("UPDATE store SET archive_reason='draft_deleted' WHERE id=$1::uuid", [
            own.secondId,
          ]);
        if (term) h.clock.set(new Date(term.endsAt.getTime() + 1));
        await holder.query("COMMIT");
        expect(errorOf((await settled)[0])).toBe(
          {
            actor: "NOT_A_MEMBER",
            member: "NOT_A_MEMBER",
            store: "NOT_FOUND",
            expiry: "STORE_LIMIT_REACHED",
          }[mode],
        );
        const trace = await h.trace(own);
        expect(trace.history.filter((row) => row.event === "store.restore")).toEqual([]);
        expect(trace.events.filter((row) => row.eventType === "store.restored")).toEqual([]);
        expect(trace.stores.find((row) => row.id === own.secondId)?.lifecycle).toBe("archived");
      } finally {
        await holder.query("ROLLBACK");
        await pending?.catch(() => undefined);
        await Promise.all([holder.end(), observer.end()]);
        await clients[1]!.$connect();
        pids[1] = await pid(clients[1]!);
      }
    },
  );

  it.each(["archive_first", "restore_first"] as const)(
    "%s 与真实归档串行，保留两次独立迁移",
    async (mode) => {
      const own = await h.archived();
      if (mode === "archive_first") await h.tenant.restoreStore(own.ctx, { storeId: own.secondId });
      const before = await h.trace(own),
        hold = paused(0);
      const observer = await connectTestDatabase(db.name, { role: null });
      const first = Promise.allSettled([
        mode === "archive_first"
          ? hold.service.tenant.archiveStore(own.ctx, { storeId: own.secondId })
          : hold.service.tenant.restoreStore(own.ctx, { storeId: own.secondId }),
      ]);
      let second: ReturnType<typeof Promise.allSettled> | undefined;
      try {
        await hold.entered;
        second = Promise.allSettled([
          mode === "archive_first"
            ? sides[1]!.tenant.restoreStore(own.ctx, { storeId: own.secondId })
            : sides[1]!.tenant.archiveStore(own.ctx, { storeId: own.secondId }),
        ]);
        await blocked(observer, pids[1]!, pids[0]!);
        hold.release();
        expect((await first)[0]?.status).toBe("fulfilled");
        expect((await second)[0]?.status).toBe("fulfilled");
        const trace = await h.trace(own);
        expect(trace.history.slice(before.history.length).map((row) => row.event)).toEqual(
          mode === "archive_first"
            ? ["store.archive", "store.restore"]
            : ["store.restore", "store.archive"],
        );
        expect(trace.stores.find((row) => row.id === own.secondId)?.lifecycle).toBe(
          mode === "archive_first" ? "active" : "archived",
        );
        expect(trace.events).toHaveLength(before.events.length + 2);
        expect(trace.audits).toHaveLength(before.audits.length + 2);
      } finally {
        hold.release();
        await first;
        await second;
        await observer.end();
      }
    },
  );

  it("真实恢复与旧已撤回邀请接受竞争，不使 token 或旧成员复活", async () => {
    const world = await archiveAcceptWorld(clients[0]!);
    const own = await world.owner(),
      person = await world.person();
    const second = await world.make.store({ entityId: own.entityId });
    await world.prisma.entity.update({
      where: { id: own.entityId },
      data: { storeLimitOverride: 2 },
    });
    const ctx = memberContext(own.userId, own.entityId, second.id);
    const card = await world.tenant.createInvitation(
      ctx,
      { clientRequestId: uuidv7() },
      { principal: own.principal },
    );
    const archive = world.archiveSide(clients[0]!);
    await archive.tenant.archiveStore(own.ctx, { storeId: second.id });
    const restore = archiveServices(clients[0]!, world.clock);
    const accept = world.side(clients[1]!);
    const results = await Promise.allSettled([
      restore.tenant.restoreStore(own.ctx, { storeId: second.id }),
      world.accept(person, card, {}, accept),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(errorOf(results[1])).toBe("INVITATION_REVOKED");
    expect(
      await world.prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
    ).toMatchObject({ status: "revoked", tokenEnc: null });
    expect(
      await world.prisma.entityMember.count({
        where: { merchantUserId: person.userId, status: "active" },
      }),
    ).toBe(0);
  });
});
