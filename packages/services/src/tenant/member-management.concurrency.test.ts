import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { managementHarness, managementServices, SLOW } from "./__fixtures__/member-management.js";
import type { ManagementHarness } from "./__fixtures__/member-management.js";

const db = useSeededDatabase("services", { max: 1 });
let h: ManagementHarness;
let clients: PrismaClient[];
let sides: ReturnType<typeof managementServices>[];
let pids: number[];
beforeAll(async () => {
  h = managementHarness(await db.prisma());
  clients = await Promise.all(
    [0, 1].map(async () => createPrismaClient({ connectionString: await db.url(), max: 1 })),
  );
  sides = clients.map((client) => managementServices(client, h.clock));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("缺少独立app后端PID");
      return row.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, SLOW);
afterAll(async () => {
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// 真业务回调已完成写入，但原事务尚未提交；finally必释放，避免失败留下挂起事务。
function pauseAfterWrite(index: number) {
  const written = latch();
  const commit = latch();
  const tx: TxRunner = {
    run: (fn, opts) =>
      sides[index]!.tx.run(async (handle) => {
        const result = await fn(handle);
        written.release();
        await commit.promise;
        return result;
      }, opts),
  };
  return { written, commit, service: managementServices(clients[index]!, h.clock, tx) };
}

const waitWritten = (hold: ReturnType<typeof pauseAfterWrite>, running: Promise<unknown>) =>
  Promise.race([
    hold.written.promise,
    running.then(() => {
      throw new Error("原业务事务未暂停即完成");
    }),
  ]);

async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  waiter: number,
  holder: number,
) {
  const deadline = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  throw new Error("未观测到已知独立app后端真实锁等待");
}

describe("成员范围调整：两真实app连接及只读owner观察", { timeout: SLOW }, () => {
  it.each(["remove", "leave"] as const)(
    "%s先完成未提交，update等待后重读removed而拒绝",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const second = await h.make.store({ entityId: owner.entityId });
      const observer = await connectTestDatabase(db.name, { role: null });
      const hold = pauseAfterWrite(0);
      const first =
        mode === "remove"
          ? hold.service.tenant.removeMember(owner.ctx, { memberId: clerk.memberId })
          : hold.service.tenant.leaveMembership(clerk.ctx);
      let secondRun: Promise<unknown> | undefined;
      const handledFirst = Promise.allSettled([first]);
      try {
        await waitWritten(hold, first);
        secondRun = sides[1]!.tenant.updateMember(owner.ctx, {
          memberId: clerk.memberId,
          storeIds: [second.id],
        });
        const handledSecond = Promise.allSettled([secondRun]);
        await blocked(observer, pids[1]!, pids[0]!);
        hold.commit.release();
        expect((await handledFirst)[0]?.status).toBe("fulfilled");
        expect((await handledSecond)[0]).toMatchObject({
          status: "rejected",
          reason: { error: "STATE_NOT_ALLOWED" },
        });
        const after = await h.trace(clerk.memberId);
        expect(after.member).toMatchObject({ status: "removed", lastStoreId: null });
        expect(after.stores).toEqual([]);
        expect(after.history).toHaveLength(1);
        expect(after.audits).toHaveLength(1);
        expect(after.events.map((x) => x.eventType)).toEqual(["entity_member.removed"]);
      } finally {
        hold.commit.release();
        await Promise.allSettled([first, ...(secondRun ? [secondRun] : [])]);
        await observer.end();
      }
    },
  );

  it.each(["remove", "leave"] as const)(
    "update先完成未提交，%s等待提交后只移除保存后的完整范围",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const second = await h.make.store({ entityId: owner.entityId });
      const observer = await connectTestDatabase(db.name, { role: null });
      const hold = pauseAfterWrite(0);
      const first = hold.service.tenant.updateMember(owner.ctx, {
        memberId: clerk.memberId,
        storeIds: [second.id, owner.storeId],
      });
      let later: Promise<unknown> | undefined;
      const handledFirst = Promise.allSettled([first]);
      try {
        await waitWritten(hold, first);
        later =
          mode === "remove"
            ? sides[1]!.tenant.removeMember(owner.ctx, { memberId: clerk.memberId })
            : sides[1]!.tenant.leaveMembership(clerk.ctx);
        const handledLater = Promise.allSettled([later]);
        await blocked(observer, pids[1]!, pids[0]!);
        hold.commit.release();
        expect((await handledFirst)[0]?.status).toBe("fulfilled");
        expect((await handledLater)[0]?.status).toBe("fulfilled");
        const after = await h.trace(clerk.memberId);
        expect(after.member).toMatchObject({ status: "removed", lastStoreId: null });
        expect(after.stores).toEqual([]);
        expect(after.history).toHaveLength(1);
        expect(after.audits).toHaveLength(2);
        expect(after.events.map((x) => x.eventType)).toEqual([
          "entity_member.stores_changed",
          "entity_member.removed",
        ]);
      } finally {
        hold.commit.release();
        await Promise.allSettled([first, ...(later ? [later] : [])]);
        await observer.end();
      }
    },
  );

  it("两次真实范围更新串行重读，以首个提交后的全集计算第二次差集", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const a = await h.make.store({ entityId: owner.entityId });
    const b = await h.make.store({ entityId: owner.entityId });
    const observer = await connectTestDatabase(db.name, { role: null });
    const hold = pauseAfterWrite(0);
    const first = hold.service.tenant.updateMember(owner.ctx, {
      memberId: clerk.memberId,
      storeIds: [a.id],
    });
    let later: Promise<unknown> | undefined;
    const handledFirst = Promise.allSettled([first]);
    try {
      await waitWritten(hold, first);
      later = sides[1]!.tenant.updateMember(owner.ctx, {
        memberId: clerk.memberId,
        storeIds: [b.id],
      });
      const handledLater = Promise.allSettled([later]);
      await blocked(observer, pids[1]!, pids[0]!);
      hold.commit.release();
      expect((await handledFirst)[0]?.status).toBe("fulfilled");
      expect((await handledLater)[0]?.status).toBe("fulfilled");
      const after = await h.trace(clerk.memberId);
      expect(after.stores.map((x) => x.storeId)).toEqual([b.id]);
      expect(after.history).toEqual([]);
      expect(after.audits).toHaveLength(2);
      expect(after.audits[1]).toMatchObject({
        before: { storeIds: [a.id] },
        after: { storeIds: [b.id] },
      });
      expect(after.events[1]?.payload).toMatchObject({
        addedStoreIds: [b.id],
        removedStoreIds: [a.id],
      });
    } finally {
      hold.commit.release();
      await Promise.allSettled([first, ...(later ? [later] : [])]);
      await observer.end();
    }
  });

  it.each(["updateFirst", "rememberFirst"] as const)(
    "%s：真实120等待后lastStore不能越过保存后的范围",
    async (order) => {
      const owner = await h.owner();
      const second = await h.make.store({ entityId: owner.entityId });
      const clerk = await h.clerk(owner, [owner.storeId, second.id]);
      const observer = await connectTestDatabase(db.name, { role: null });
      const hold = pauseAfterWrite(0);
      const remember = (side: ReturnType<typeof managementServices>) =>
        side.tenant.rememberCurrentStore({ merchantUserId: clerk.userId, storeId: owner.storeId });
      const update = (side: ReturnType<typeof managementServices>) =>
        side.tenant.updateMember(owner.ctx, { memberId: clerk.memberId, storeIds: [second.id] });
      const first = order === "updateFirst" ? update(hold.service) : remember(hold.service);
      let later: Promise<unknown> | undefined;
      const handledFirst = Promise.allSettled([first]);
      try {
        await waitWritten(hold, first);
        later = order === "updateFirst" ? remember(sides[1]!) : update(sides[1]!);
        const handledLater = Promise.allSettled([later]);
        await blocked(observer, pids[1]!, pids[0]!);
        hold.commit.release();
        expect((await handledFirst)[0]?.status).toBe("fulfilled");
        const result = (await handledLater)[0];
        if (order === "updateFirst")
          expect(result).toMatchObject({ status: "rejected", reason: { error: "NOT_FOUND" } });
        else expect(result?.status).toBe("fulfilled");
        const after = await h.trace(clerk.memberId);
        expect(after.member.lastStoreId).toBeNull();
        expect(after.stores.map((x) => x.storeId)).toEqual([second.id]);
        expect(after.events).toHaveLength(1);
        expect(after.audits).toHaveLength(1);
        expect(after.history).toEqual([]);
      } finally {
        hold.commit.release();
        await Promise.allSettled([first, ...(later ? [later] : [])]);
        await observer.end();
      }
    },
  );

  it("请求新店130锁等待期间被实际归档，锁后拒绝且没有部分范围副作用", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const second = await h.make.store({ entityId: owner.entityId });
    const holder = await connectTestDatabase(db.name);
    const observer = await connectTestDatabase(db.name, { role: null });
    let running: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      await holder.query("SELECT id FROM store WHERE id=$1::uuid FOR UPDATE", [second.id]);
      running = sides[1]!.tenant.updateMember(owner.ctx, {
        memberId: clerk.memberId,
        storeIds: [second.id],
      });
      const settled = Promise.allSettled([running]);
      await blocked(observer, pids[1]!, pid);
      await holder.query(
        "UPDATE store SET lifecycle='archived', archived_at=$2, archive_reason='by_owner', archive_actor_type='merchant', archive_actor_id=$3::uuid, archive_client='weapp' WHERE id=$1::uuid",
        [second.id, h.clock.now(), owner.userId],
      );
      await holder.query("COMMIT");
      expect((await settled)[0]).toMatchObject({
        status: "rejected",
        reason: { error: "VALIDATION_FAILED" },
      });
      const after = await h.trace(clerk.memberId);
      expect(after.stores.map((x) => x.storeId)).toEqual([owner.storeId]);
      expect(after.member.lastStoreId).toBe(owner.storeId);
      expect(after.audits).toEqual([]);
      expect(after.events).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      if (running) await Promise.allSettled([running]);
      await holder.end();
      await observer.end();
    }
  });

  it.each(["ownerChanged", "accountDeleted"] as const)(
    "主体100等待期间%s，旧operator不能凭旧context调整店员",
    async (change) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const successor = await h.clerk(owner);
      const staff = await h.make.staff();
      const holder = await connectTestDatabase(db.name);
      const observer = await connectTestDatabase(db.name, { role: null });
      let running: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
          .pid;
        await holder.query("SELECT id FROM entity WHERE id=$1::uuid FOR UPDATE", [owner.entityId]);
        running = sides[1]!.tenant.updateMember(owner.ctx, {
          memberId: clerk.memberId,
          storeIds: [owner.storeId],
        });
        const settled = Promise.allSettled([running]);
        await blocked(observer, pids[1]!, pid);
        if (change === "ownerChanged") {
          // 尚未交付的老板更换producer不在此实现；仅同Tx建立合法当前历史终态。
          await holder.query(
            "UPDATE entity_member SET status='removed',removed_at=$2,remove_reason='owner_transfer',remove_actor_type='staff',remove_actor_id=$3::uuid,remove_client='admin',last_store_id=NULL WHERE id=$1::uuid",
            [owner.memberId, h.clock.now(), staff.id],
          );
          await holder.query("DELETE FROM store_member WHERE entity_member_id=$1::uuid", [
            successor.memberId,
          ]);
          await holder.query("UPDATE entity_member SET role='owner' WHERE id=$1::uuid", [
            successor.memberId,
          ]);
        } else {
          // 合法销号历史终态，历史active membership保留，必须重验当前账号。
          await holder.query(
            "UPDATE merchant_user SET status='deleted',deleted_at=$2,phone_enc=NULL,phone_bidx=NULL,phone_mask=NULL,phone_last4=NULL,display_name=NULL WHERE id=$1::uuid",
            [owner.userId, h.clock.now()],
          );
        }
        await holder.query("COMMIT");
        expect((await settled)[0]).toMatchObject({
          status: "rejected",
          reason: { error: "NOT_A_MEMBER" },
        });
        const after = await h.trace(clerk.memberId);
        expect(after.stores.map((x) => x.storeId)).toEqual([owner.storeId]);
        expect(after.audits).toEqual([]);
        expect(after.events).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        if (running) await Promise.allSettled([running]);
        await holder.end();
        await observer.end();
      }
    },
  );
});
