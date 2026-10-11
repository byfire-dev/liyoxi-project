import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { standingOf } from "../authz/index.js";
import {
  createIdempotencyContext,
  createIdentityContext,
  isAppError,
  uuidv7,
} from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../testing/index.js";
import { claimTimers, runTimer } from "../timers/index.js";
import {
  deleteContext,
  deleteHarness,
  deleteIdem,
  deleteServices,
  SLOW,
} from "./__fixtures__/store-delete.js";
import type { DeleteHarness, DeleteWorld } from "./__fixtures__/store-delete.js";

const db = useSeededDatabase("services");
let h: DeleteHarness,
  clients: PrismaClient[],
  sides: ReturnType<typeof deleteServices>[],
  pids: number[];
beforeAll(async () => {
  const url = await db.url();
  clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  h = deleteHarness(clients[0]!);
  sides = clients.map((client) => deleteServices(client, h.base));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("业务连接缺少真实 PID");
      return row.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, SLOW);
afterAll(async () => {
  sides?.forEach((side) => side.close());
  h?.close();
  await Promise.all(clients?.map((client) => client.$disconnect()) ?? []);
}, SLOW);
function code(result: PromiseSettledResult<unknown> | undefined) {
  expect(result?.status).toBe("rejected");
  const error: unknown = result?.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}
function pause(
  index: number,
  condition: (tx: Tx) => Promise<boolean> = async () => true,
  failure?: Error,
) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TxRunner = {
    run: (fn, options) =>
      sides[index]!.tx.run(async (tx) => {
        const result = await fn(tx);
        if (await condition(tx)) {
          enter();
          await gate;
          if (failure) throw failure;
        }
        return result;
      }, options),
  };
  return { runner, entered, release, service: deleteServices(clients[index]!, h.base, runner) };
}
async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  waiter = pids[1]!,
  holder = pids[0]!,
) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) {
      const all = await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid",
      );
      expect(all.rows.map((row) => row.pid)).toEqual([holder, waiter].sort((a, b) => a - b));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("未观察到两业务连接实际阻塞");
}
const remove = (side: ReturnType<typeof deleteServices>, w: DeleteWorld, key = uuidv7()) =>
  side.tenant.deleteStore(
    w.ctx,
    { storeId: w.store.id },
    { idem: deleteIdem(w.ctx, w.store.id, key) },
  );
async function race(
  hold: ReturnType<typeof pause>,
  firstAction: (side: ReturnType<typeof deleteServices>) => Promise<unknown>,
  secondAction: (side: ReturnType<typeof deleteServices>) => Promise<unknown>,
) {
  const observer = await connectTestDatabase(db.name, { role: null });
  const first = Promise.allSettled([firstAction(hold.service)]);
  let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await hold.entered;
    second = Promise.allSettled([secondAction(sides[1]!)]);
    await blocked(observer);
    hold.release();
    return [(await first)[0]!, (await second)[0]!] as const;
  } finally {
    hold.release();
    await first;
    await second;
    await observer.end();
    hold.service.close();
  }
}
async function unique(w: DeleteWorld, archivedEventCount: 1 | 2 = 1) {
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: w.store.id, event: "store.draft_delete" },
    }),
  ).toBe(1);
  expect(
    await h.prisma.auditLog.count({
      where: { entityId: w.entity.id, action: "tenant.store.draft_delete" },
    }),
  ).toBe(1);
  for (const eventType of ["store.archived", "store.draft_deleted"])
    expect(
      await h.prisma.outboxEvent.count({ where: { aggregateId: w.store.id, eventType } }),
    ).toBe(eventType === "store.archived" ? archivedEventCount : 1);
}

describe("草稿删除：两真实业务连接的完整锁图", { timeout: SLOW }, () => {
  it.each(["same_key", "different_key", "rollback"] as const)(
    "%s 保原事务收据与恰一次副作用",
    async (mode) => {
      const w = await h.world(),
        key = uuidv7(),
        failure = new Error("真实首事务回滚");
      const hold = pause(0, undefined, mode === "rollback" ? failure : undefined);
      const [first, second] = await race(
        hold,
        (side) => remove(side, w, key),
        (side) => remove(side, w, mode === "same_key" ? key : uuidv7()),
      );
      if (mode === "rollback") expect(first).toMatchObject({ status: "rejected", reason: failure });
      else expect(first.status).toBe("fulfilled");
      if (mode === "different_key") expect(code(second)).toBe("NOT_FOUND");
      else expect(second.status).toBe("fulfilled");
      if (mode === "same_key") expect(first).toEqual(second);
      await unique(w);
    },
  );

  it("两个最后有效目标按同一主体串行，只删一家且另一 fresh LAST_ACTIVE_STORE", async () => {
    const w = await h.world();
    const [first, second] = await race(
      pause(0),
      (side) => remove(side, w),
      (side) => remove(side, { ...w, store: w.primary }),
    );
    expect(first.status).toBe("fulfilled");
    expect(code(second)).toBe("LAST_ACTIVE_STORE");
    expect(
      await h.prisma.store.count({ where: { entityId: w.entity.id, lifecycle: "active" } }),
    ).toBe(1);
    await unique(w);
  });

  it.each([
    "delete_then_restore",
    "restore_then_delete",
    "delete_frees_quota",
    "restore_adds_last_active",
    "archive_context",
    "restore_context",
  ] as const)("%s 重读目标、当前上下文及同一额度图", async (mode) => {
    let w = await h.world();
    const third = await h.make.store({ entityId: w.entity.id });
    if (mode !== "archive_context") await h.tenant.archiveStore(w.ctx, { storeId: third.id });
    if (mode === "restore_then_delete") await h.tenant.archiveStore(w.ctx, { storeId: w.store.id });
    if (mode === "restore_adds_last_active") {
      await h.tenant.archiveStore(w.ctx, { storeId: w.primary.id });
      w = { ...w, ctx: deleteContext(w.user.id, w.entity.id, w.store.id) };
    }
    if (mode === "restore_context") {
      await h.tenant.archiveStore(w.ctx, { storeId: w.primary.id });
      // 服务层持有原合法 archived ctx；HTTP 原中间件仍先拒绝，不声明 HTTP 绕过。
      await h.prisma.entity.update({ where: { id: w.entity.id }, data: { storeLimitOverride: 3 } });
    }
    const [first, second] = await race(
      pause(0),
      (side) =>
        mode === "restore_then_delete"
          ? side.tenant.restoreStore(w.ctx, { storeId: w.store.id })
          : mode === "restore_adds_last_active"
            ? side.tenant.restoreStore(w.ctx, { storeId: third.id })
            : mode === "archive_context"
              ? side.tenant.archiveStore(w.ctx, { storeId: w.primary.id })
              : mode === "restore_context"
                ? side.tenant.restoreStore(w.ctx, { storeId: w.primary.id })
                : remove(side, w),
      (side) =>
        mode === "delete_then_restore"
          ? side.tenant.restoreStore(w.ctx, { storeId: w.store.id })
          : mode === "delete_frees_quota"
            ? side.tenant.restoreStore(w.ctx, { storeId: third.id })
            : remove(side, w),
    );
    expect(first.status).toBe("fulfilled");
    if (mode === "delete_then_restore") expect(code(second)).toBe("NOT_FOUND");
    else if (mode === "archive_context") expect(code(second)).toBe("STORE_ARCHIVED");
    else expect(second.status).toBe("fulfilled");
    expect(
      await h.prisma.store.count({ where: { entityId: w.entity.id, lifecycle: "active" } }),
    ).toBeGreaterThan(0);
    if (mode !== "archive_context") await unique(w, mode === "restore_then_delete" ? 2 : 1);
  });

  it("额度已满的 restore 先真实失败零写，随后 delete 释放额度", async () => {
    const w = await h.world(),
      third = await h.make.store({ entityId: w.entity.id });
    await h.tenant.archiveStore(w.ctx, { storeId: third.id });
    const before = await h.state();
    await expect(sides[0]!.tenant.restoreStore(w.ctx, { storeId: third.id })).rejects.toMatchObject(
      { error: "STORE_LIMIT_REACHED" },
    );
    expect(await h.state()).toEqual(before);
    await remove(sides[1]!, w);
    expect(await sides[0]!.tenant.restoreStore(w.ctx, { storeId: third.id })).toMatchObject({
      lifecycle: "active",
    });
  });

  it.each(["create_first", "delete_first"] as const)(
    "%s 真实创建阶段持锁，删除发现完整邀请并取消 timer",
    async (mode) => {
      const w = await h.world(),
        clientRequestId = uuidv7();
      const hold = pause(
        0,
        mode === "create_first"
          ? async (tx) =>
              (await tx.invitation.count({
                where: { storeId: w.store.id, clientRequestId, status: "pending" },
              })) === 1
          : undefined,
      );
      const create = (side: ReturnType<typeof deleteServices>) =>
        side.tenant.createInvitation(deleteContext(w.user.id, w.entity.id, w.store.id), {
          clientRequestId,
        });
      const [first, second] = await race(
        hold,
        mode === "create_first" ? create : (side) => remove(side, w),
        mode === "create_first" ? (side) => remove(side, w) : create,
      );
      expect(first.status).toBe("fulfilled");
      if (mode === "create_first") {
        expect(second.status).toBe("fulfilled");
        const row = await h.prisma.invitation.findFirstOrThrow({ where: { storeId: w.store.id } });
        expect(row).toMatchObject({
          status: "revoked",
          tokenEnc: null,
          revokeReason: "store_archived",
        });
        expect(
          await h.prisma.timer.findFirstOrThrow({
            where: { subjectId: row.id, kind: "invitation.expire" },
          }),
        ).toMatchObject({ status: "cancelled" });
      } else {
        expect(code(second)).toBe("NOT_A_MEMBER");
        expect(await h.prisma.invitation.count({ where: { storeId: w.store.id } })).toBe(0);
      }
      await unique(w);
    },
  );

  it.each(["accept_first", "delete_first"] as const)(
    "%s 真实身份接受与完整级联不丢新增范围",
    async (mode) => {
      const w = await h.world(),
        person = await h.person(),
        card = await h.card(w);
      const input = {
        invitationId: card.invitationId,
        token: card.token,
        displayName: "真实接受店员",
      };
      const accept = (side: ReturnType<typeof deleteServices>) =>
        side.tenant.acceptInvitation(person.ctx, input, {
          principal: person.principal,
          idem: createIdempotencyContext({
            mode: "required",
            scope: "m.invitation.accept",
            actor: person.ctx.actor,
            key: uuidv7(),
            request: {
              method: "POST",
              pathParams: { invitationId: card.invitationId },
              body: { token: card.token, displayName: input.displayName },
            },
          }),
        });
      const hold = pause(
        0,
        mode === "accept_first"
          ? async (tx) =>
              (await tx.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }))
                .status === "accepted"
          : undefined,
      );
      const secondGate = pause(1),
        observer = await connectTestDatabase(db.name, { role: null });
      const first = Promise.allSettled([
        mode === "accept_first" ? accept(hold.service) : remove(hold.service, w),
      ]);
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await hold.entered;
        second = Promise.allSettled([
          mode === "accept_first" ? remove(secondGate.service, w) : accept(sides[1]!),
        ]);
        await blocked(observer);
        hold.release();
        if (mode === "accept_first") {
          await secondGate.entered;
          expect((await first)[0]).toMatchObject({ status: "fulfilled", value: { role: "clerk" } });
          secondGate.release();
          expect((await second)[0]?.status).toBe("fulfilled");
          const member = await h.prisma.entityMember.findFirstOrThrow({
            where: { merchantUserId: person.principal.merchantUserId, entityId: w.entity.id },
          });
          expect(member).toMatchObject({ status: "removed", removeReason: "store_archived" });
          expect(
            await h.prisma.storeMember.findMany({ where: { entityMemberId: member.id } }),
          ).toEqual([]);
        } else {
          expect((await first)[0]?.status).toBe("fulfilled");
          expect(code((await second)[0])).toBe("INVITATION_REVOKED");
        }
        await unique(w);
      } finally {
        hold.release();
        secondGate.release();
        await first;
        await second;
        await observer.end();
        hold.service.close();
        secondGate.service.close();
      }
    },
  );

  it.each(["delete_first", "expire_first"] as const)(
    "%s 与真实 dispatched expiry 串行且 I30 不复活终态",
    async (mode) => {
      const w = await h.world(),
        card = await h.card(w);
      h.clock.set(new Date(new Date(card.expiresAt).getTime() + 1));
      const timer = await h.prisma.timer.findFirstOrThrow({
        where: { subjectId: card.invitationId, kind: "invitation.expire" },
      });
      const claimed = await h.tx.run((tx) => claimTimers(tx, h.timers.registry, h.clock.now()));
      const ref = claimed.claimed.find((r) => r.timerId === timer.id);
      if (!ref) throw new Error("没有原 timer 的真实认领");
      const [first, second] = await race(
        pause(0),
        mode === "delete_first"
          ? (side) => remove(side, w)
          : (side) => runTimer(side.timerDeps, ref),
        mode === "delete_first"
          ? (side) => runTimer(side.timerDeps, ref)
          : (side) => remove(side, w),
      );
      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("fulfilled");
      if (mode === "delete_first")
        expect(second).toEqual({ status: "fulfilled", value: "skipped" });
      else expect(first).toEqual({ status: "fulfilled", value: "fired" });
      expect(await runTimer(sides[1]!.timerDeps, ref)).toBe("stale");
      expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: ref.timerId } })).toMatchObject({
        status: mode === "delete_first" ? "cancelled" : "fired",
      });
      expect(
        await h.tx.run((tx) => h.expiry.checkI30(tx, { entityIds: [w.entity.id] }, h.clock.now())),
      ).toEqual([]);
    },
  );

  it.each(["asset_first", "delete_first"] as const)(
    "%s 实际 media 原创上传与 store130 fresh 判断",
    async (mode) => {
      const w = await h.world(),
        mediaFixture = await createMediaAssetsHarness(clients[mode === "asset_first" ? 0 : 1]!);
      const actor = {
        identity: createIdentityContext({
          ...deleteContext(w.user.id, w.entity.id, w.store.id),
          actor: { type: "merchant", id: w.user.id, client: "weapp", role: "owner" },
        }),
        merchant: {
          entityId: w.entity.id,
          storeId: w.store.id,
          standing: standingOf("owner", "active"),
        },
      };
      const hold = pause(
        0,
        mode === "asset_first"
          ? async (tx) => (await tx.storeAsset.count({ where: { storeId: w.store.id } })) > 0
          : undefined,
      );
      const media = createMedia({
        tx: mode === "asset_first" ? hold.runner : sides[1]!.tx,
        clock: mediaFixture.clock,
        events: mediaFixture.events,
        assembly: mediaFixture.assembly,
        storage: mediaFixture.fake.storage,
        assets: mediaFixture.assets,
      });
      try {
        const [first, second] = await race(
          hold,
          mode === "asset_first"
            ? () => media.assets.create(actor, { type: "text", textBody: "真实公开上传" })
            : (side) => remove(side, w),
          mode === "asset_first"
            ? (side) => remove(side, w)
            : () => media.assets.create(actor, { type: "text", textBody: "删除之后不能上传" }),
        );
        expect(first.status).toBe("fulfilled");
        expect(code(second)).toBe(mode === "asset_first" ? "STORE_NOT_DRAFT" : "STATE_NOT_ALLOWED");
        expect(await h.prisma.storeAsset.count({ where: { storeId: w.store.id } })).toBe(
          mode === "asset_first" ? 1 : 0,
        );
      } finally {
        await mediaFixture.close();
      }
    },
  );

  it("公开素材软删减少阻断，先看见原创时保守拒绝，软删提交后可删店", async () => {
    const w = await h.world(),
      asset = await h.asset(w),
      media = await createMediaAssetsHarness(clients[0]!);
    try {
      await expect(remove(sides[1]!, w)).rejects.toMatchObject({ error: "STORE_NOT_DRAFT" });
      await media.media.assets.remove(media.admin, asset.id, { reasonText: "删除虚构历史素材" });
      expect(await remove(sides[1]!, w)).toMatchObject({ storeId: w.store.id });
      expect(
        await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.id } }),
      ).toMatchObject({ deletedAt: expect.any(Date), textBody: asset.textBody });
    } finally {
      await media.close();
    }
  });
});
