import { beforeAll, expect, it } from "vitest";
import { MessageListQuerySchema } from "@liyoxi/contract";
import { createConfig } from "../config/index.js";
import { createIdempotencyContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  useSeededDatabase,
  createNotifyMessageFixture,
  changeNotifyMessageAccessFixture,
} from "../testing/index.js";
import { createNotifyMessages } from "./messages.js";
import type { NotifyMessages } from "./messages.js";
import { countUnread } from "./messages.scope.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T15:59:59.000Z"));
let service: NotifyMessages;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let tx: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  service = createNotifyMessages({
    tx,
    clock,
    config: createConfig({ db: prisma, clock, redis: null }),
    purchaseMode: async () => "in_app",
  });
}, 120_000);
const list = (
  actor: { merchantUserId: string; storeId: string | null },
  query: Record<string, unknown> = {},
) => service.list(actor, MessageListQuerySchema.parse(query));

it("账号消息在没有主体时可读；用户、主体、门店与ownerOnly不泄露，日期按上海", async () => {
  const own = await make.merchant();
  const another = await make.merchant();
  const account = await createNotifyMessageFixture(prisma, clock, { merchantUserId: own.user.id });
  await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    isOwnerOnly: true,
  });
  await createNotifyMessageFixture(prisma, clock, { merchantUserId: another.user.id });
  const actor = { merchantUserId: own.user.id, storeId: null };
  expect((await list(actor)).items.map((item) => item.messageId)).toEqual([account.id]);
  expect((await list(actor)).items[0]?.createdDate).toBe("2026-10-08");
  expect(await service.summary(actor)).toMatchObject({ total: 1, byStore: [] });
  await expect(service.read(actor, uuidv7())).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(service.summary({ ...actor, storeId: "not-a-uuid" })).rejects.toMatchObject({
    error: "NOT_A_MEMBER",
  });
  await expect(service.summary({ ...actor, storeId: another.store.id })).rejects.toMatchObject({
    error: "NOT_A_MEMBER",
  });
});

it("店员门店/客服消息与主体消息可见；老板限制不因另一主体老板关系放行，移除门店后立即隐藏", async () => {
  const own = await make.merchant();
  const second = await make.store({ entityId: own.entity.id });
  const clerk = await make.merchantUser();
  const member = await make.entityMember({ entityId: own.entity.id, merchantUserId: clerk.id });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: own.store.id,
    entityId: own.entity.id,
    addedByMemberId: own.owner.id,
  });
  const allowed = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: clerk.id,
    entityId: own.entity.id,
    storeId: own.store.id,
    category: "service",
  });
  await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: clerk.id,
    entityId: own.entity.id,
    storeId: second.id,
  });
  const denied = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: clerk.id,
    entityId: own.entity.id,
    isOwnerOnly: true,
  });
  const actor = { merchantUserId: clerk.id, storeId: own.store.id };
  expect((await list(actor)).items.map((item) => item.messageId)).toEqual([allowed.id]);
  await expect(service.read(actor, denied.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
  await prisma.storeMember.delete({
    where: { entityMemberId_storeId: { storeId: own.store.id, entityMemberId: member.id } },
  });
  await expect(service.summary(actor)).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
});

it("老板换人后原账号ownerOnly消息不交给新老板，原账号仍可读账号消息", async () => {
  const own = await make.merchant();
  const replacement = await make.merchantUser();
  const limited = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    isOwnerOnly: true,
  });
  const account = await createNotifyMessageFixture(prisma, clock, { merchantUserId: own.user.id });
  await prisma.entityMember.update({ where: { id: own.owner.id }, data: { role: "clerk" } });
  await make.entityMember({
    entityId: own.entity.id,
    merchantUserId: replacement.id,
    role: "owner",
  });
  await make.storeMember({
    entityMemberId: own.owner.id,
    storeId: own.store.id,
    entityId: own.entity.id,
    addedByMemberId: own.owner.id,
  });
  expect(
    (await list({ merchantUserId: own.user.id, storeId: own.store.id })).items.map(
      (item) => item.messageId,
    ),
  ).toEqual([account.id]);
  await expect(
    service.read({ merchantUserId: own.user.id, storeId: own.store.id }, limited.id),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect((await list({ merchantUserId: replacement.id, storeId: own.store.id })).items).toEqual([]);
});

it("id DESC游标无重复/总数；无效游标400；批读上界和页签不吞新消息，8tabs不生成systemtab", async () => {
  const own = await make.merchant();
  const actor = { merchantUserId: own.user.id, storeId: own.store.id };
  const older = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    category: "store",
  });
  const upper = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    category: "store",
  });
  const newer = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    category: "store",
  });
  const other = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    category: "system",
  });
  const first = await list(actor, { limit: 2 });
  expect(first.hasMore).toBe(true);
  const rest = await list(actor, { cursor: first.nextCursor!, limit: 2 });
  expect(new Set([...first.items, ...rest.items].map((item) => item.messageId)).size).toBe(4);
  expect(rest.hasMore).toBe(false);
  await expect(list(actor, { cursor: "bad" })).rejects.toMatchObject({
    error: "VALIDATION_FAILED",
  });
  const result = await service.batchRead(actor, { upToMessageId: upper.id, tab: "store" });
  expect(result.markedCount).toBe(2);
  expect(result.summary.total).toBe(2);
  expect(result.summary.byTab.map((item) => item.tab)).toEqual([
    "all",
    "order",
    "delivery",
    "launch",
    "plan_points",
    "review",
    "store",
    "service",
  ]);
  expect(
    (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: older.id } })).readAt,
  ).toEqual(clock.now());
  expect(
    (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: newer.id } })).readAt,
  ).toBeNull();
  expect(
    (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: other.id } })).readAt,
  ).toBeNull();
});

it("并发单读保留首次readAt；重复批读计数0，没有额外通知/审计/出站事件", async () => {
  const own = await make.merchant();
  const message = await createNotifyMessageFixture(prisma, clock, { merchantUserId: own.user.id });
  const actor = { merchantUserId: own.user.id, storeId: null };
  const before = await Promise.all([
    prisma.notification.count(),
    prisma.auditLog.count(),
    prisma.outboxEvent.count(),
  ]);
  const values = await Promise.all([
    service.read(actor, message.id),
    service.read(actor, message.id),
  ]);
  expect(values[0]).toEqual(values[1]);
  clock.advance(1_000);
  expect(await service.read(actor, message.id)).toEqual(values[0]);
  expect(
    (await service.batchRead(actor, { upToMessageId: message.id, tab: "all" })).markedCount,
  ).toBe(0);
  expect(
    await Promise.all([
      prisma.notification.count(),
      prisma.auditLog.count(),
      prisma.outboxEvent.count(),
    ]),
  ).toEqual(before);
});

it("current_store计数按门店；事实多门店union distinct；all_stores每店相同且剔除当前不可见门店", async () => {
  const own = await make.merchant();
  const second = await make.store({ entityId: own.entity.id });
  await createNotifyMessageFixture(prisma, clock, { merchantUserId: own.user.id });
  await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
  });
  for (const storeId of [own.store.id, second.id])
    await createNotifyMessageFixture(prisma, clock, {
      merchantUserId: own.user.id,
      entityId: own.entity.id,
      storeId,
    });
  const actor = { merchantUserId: own.user.id, storeId: own.store.id };
  const current = await service.summary(actor);
  expect(current.total).toBe(3);
  expect(current.byStore.map((row) => row.unreadCount)).toEqual([3, 3]);
  expect(
    await tx.run((db) =>
      countUnread(db, {
        merchantUserId: own.user.id,
        entityId: own.entity.id,
        storeIds: [own.store.id, second.id, second.id],
        now: clock.now(),
      }),
    ),
  ).toBe(4);
  const staff = await make.staff();
  await prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "inbox.scope",
      value: "all_stores",
      effectiveAt: clock.now(),
      createdAt: clock.now(),
      createdByStaffId: staff.id,
    },
  });
  expect(await service.summary(actor)).toMatchObject({ total: 4 });
  expect((await service.summary(actor)).byStore.map((row) => row.unreadCount)).toEqual([4, 4]);
  await prisma.store.update({
    where: { id: second.id },
    data: {
      lifecycle: "archived",
      archiveReason: "draft_deleted",
      archivedAt: clock.now(),
      archiveActorType: "system",
    },
  });
  expect((await service.summary(actor)).total).toBe(3);
});

it("老板自己停用仍可读，草稿删除不能进入；账号被停用后最终SQL不读不改", async () => {
  const own = await make.merchant();
  const msg = await createNotifyMessageFixture(prisma, clock, { merchantUserId: own.user.id });
  const actor = { merchantUserId: own.user.id, storeId: own.store.id };
  await prisma.store.update({
    where: { id: own.store.id },
    data: {
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: clock.now(),
      archiveActorType: "merchant",
      archiveActorId: own.user.id,
      archiveClient: "weapp",
    },
  });
  expect((await list(actor)).items.map((item) => item.messageId)).toEqual([msg.id]);
  await prisma.store.update({
    where: { id: own.store.id },
    data: { archiveReason: "draft_deleted" },
  });
  await expect(service.summary(actor)).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
  await prisma.merchantUser.update({ where: { id: own.user.id }, data: { status: "disabled" } });
  const account = { merchantUserId: own.user.id, storeId: null };
  expect((await list(account)).items).toEqual([]);
  expect(
    (await service.batchRead(account, { upToMessageId: msg.id, tab: "all" })).markedCount,
  ).toBe(0);
  await expect(service.read(account, msg.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
});

it("同一真实事务内scope刚解析owner后改为clerk，最终list/条件UPDATE再验，不继承旧授权", async () => {
  for (const operation of ["list", "read", "batch"] as const) {
    const own = await make.merchant();
    const replacement = await make.merchantUser();
    const message = await createNotifyMessageFixture(prisma, clock, {
      merchantUserId: own.user.id,
      entityId: own.entity.id,
      isOwnerOnly: true,
    });
    let changed = false;
    // 保留真正 tx.run 的 branded句柄/SQL；仅在首条上下文查询返回后安排实际角色变化。
    const interleaved: TxRunner = {
      run: (fn, options) =>
        tx.run(async (real) => {
          const view = new Proxy(real, {
            get(target, key) {
              if (key !== "$queryRaw") return Reflect.get(target, key);
              return async (...args: unknown[]) => {
                const result: unknown = await Reflect.apply(target.$queryRaw, target, args);
                const query = args[0];
                if (
                  !changed &&
                  Array.isArray(query) &&
                  query.some(
                    (part: unknown) =>
                      typeof part === "string" && part.includes("FROM store st JOIN entity_member"),
                  )
                ) {
                  changed = true;
                  await real.entityMember.update({
                    where: { id: own.owner.id },
                    data: { role: "clerk" },
                  });
                  const currentOwner = await createFactories({ db: real, clock }).entityMember({
                    entityId: own.entity.id,
                    merchantUserId: replacement.id,
                    role: "owner",
                  });
                  await createFactories({ db: real, clock }).storeMember({
                    entityMemberId: own.owner.id,
                    storeId: own.store.id,
                    entityId: own.entity.id,
                    addedByMemberId: currentOwner.id,
                  });
                }
                return result;
              };
            },
          });
          return fn(view);
        }, options),
    };
    const guarded = createNotifyMessages({
      tx: interleaved,
      clock,
      config: createConfig({ db: prisma, clock, redis: null }),
      purchaseMode: async () => "in_app",
    });
    const actor = { merchantUserId: own.user.id, storeId: own.store.id };
    if (operation === "list")
      expect((await guarded.list(actor, MessageListQuerySchema.parse({}))).items).toEqual([]);
    if (operation === "read")
      await expect(guarded.read(actor, message.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    if (operation === "batch")
      expect(
        (await guarded.batchRead(actor, { upToMessageId: message.id, tab: "all" })).markedCount,
      ).toBe(0);
    expect(changed).toBe(true);
    expect(
      (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: message.id } })).readAt,
    ).toBeNull();
  }
});

const replayOptions = (
  actor: { merchantUserId: string; storeId: string | null },
  operation: "read" | "batchRead",
  messageId: string,
  key: string,
) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope: `m.message.${operation}`,
    actor: { type: "merchant", id: actor.merchantUserId, role: null, client: "weapp" },
    key,
    request: {
      method: "POST",
      storeId: actor.storeId,
      pathParams: operation === "read" ? { messageId } : {},
      body: operation === "read" ? null : { upToMessageId: messageId, tab: "all" },
    },
  }),
});

for (const change of ["remove_membership", "archive_store"] as const)
  for (const operation of ["read", "batchRead"] as const)
    it(`真实同键${operation}在${change}后拒绝重放，不沿用旧成员授权`, async () => {
      const own = await make.merchant();
      let userId = own.user.id;
      if (change === "remove_membership") {
        const clerk = await make.merchantUser();
        const member = await make.entityMember({
          entityId: own.entity.id,
          merchantUserId: clerk.id,
        });
        await make.storeMember({
          entityMemberId: member.id,
          entityId: own.entity.id,
          storeId: own.store.id,
          addedByMemberId: own.owner.id,
        });
        userId = clerk.id;
      }
      const actor = { merchantUserId: userId, storeId: own.store.id };
      const row = await createNotifyMessageFixture(prisma, clock, {
        merchantUserId: userId,
        entityId: own.entity.id,
        storeId: own.store.id,
      });
      const key = uuidv7();
      const invoke = (sameKey = key) =>
        operation === "read"
          ? service.read(actor, row.id, replayOptions(actor, operation, row.id, sameKey))
          : service.batchRead(
              actor,
              { upToMessageId: row.id, tab: "all" },
              replayOptions(actor, operation, row.id, sameKey),
            );
      await invoke();
      const firstRead = (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: row.id } }))
        .readAt;
      await changeNotifyMessageAccessFixture(prisma, clock, {
        merchantUserId: userId,
        entityId: own.entity.id,
        storeId: own.store.id,
        change,
      });
      await expect(invoke(uuidv7())).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
      await expect(invoke()).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
      expect(
        (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: row.id } })).readAt,
      ).toEqual(firstRead);
    });

it("owner降店员后单读同键404，批读重放保留历史markedCount但摘要按当前权限，DML不重执", async () => {
  const own = await make.merchant();
  const actor = { merchantUserId: own.user.id, storeId: own.store.id };
  const limited = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    isOwnerOnly: true,
    category: "plan_points",
  });
  const upper = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  const unreadLimited = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    isOwnerOnly: true,
    category: "plan_points",
  });
  const readKey = uuidv7(),
    batchKey = uuidv7();
  const first = await service.read(
    actor,
    limited.id,
    replayOptions(actor, "read", limited.id, readKey),
  );
  const body = { upToMessageId: upper.id, tab: "all" as const };
  const marked = await service.batchRead(
    actor,
    body,
    replayOptions(actor, "batchRead", upper.id, batchKey),
  );
  expect(marked).toMatchObject({ markedCount: 1, summary: { total: 1 } });
  expect(marked.summary.byTab.find((item) => item.tab === "plan_points")?.unreadCount).toBe(1);
  await changeNotifyMessageAccessFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: own.store.id,
    change: "downgrade_owner",
  });
  clock.advance(1000);
  const newer = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  await expect(
    service.read(actor, limited.id, replayOptions(actor, "read", limited.id, readKey)),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  const replay = await service.batchRead(
    actor,
    body,
    replayOptions(actor, "batchRead", upper.id, batchKey),
  );
  expect(replay.markedCount).toBe(marked.markedCount);
  expect(replay.summary).toEqual(await service.summary(actor));
  expect(replay.summary.byTab.find((item) => item.tab === "plan_points")?.unreadCount).toBe(0);
  expect(replay.summary.byStore).toEqual([{ storeId: own.store.id, unreadCount: 1 }]);
  expect(
    (
      await prisma.merchantMessage.findUniqueOrThrow({ where: { id: limited.id } })
    ).readAt?.toISOString(),
  ).toBe(first.readAt);
  for (const row of [newer, unreadLimited])
    expect(
      (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: row.id } })).readAt,
    ).toBeNull();
});

it("批读同权限保留首次summary，inbox范围与可进其他店变化才重裁且不重执DML", async () => {
  const own = await make.merchant();
  const second = await make.store({ entityId: own.entity.id });
  const actor = { merchantUserId: own.user.id, storeId: own.store.id };
  const staff = await make.staff();
  const setScope = async (value: "current_store" | "all_stores") => {
    clock.advance(1);
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "inbox.scope",
        value,
        effectiveAt: clock.now(),
        createdAt: clock.now(),
        createdByStaffId: staff.id,
      },
    });
  };
  await setScope("current_store");
  const upper = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  const other = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: second.id,
  });
  const body = { upToMessageId: upper.id, tab: "all" as const };
  const key = uuidv7();
  const invoke = () =>
    service.batchRead(actor, body, replayOptions(actor, "batchRead", upper.id, key));
  const first = await invoke();
  expect(first).toMatchObject({ markedCount: 1, summary: { total: 0 } });
  const newer = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  expect((await service.summary(actor)).total).toBe(1);
  expect(await invoke()).toEqual(first);
  await setScope("all_stores");
  expect(await invoke()).toEqual({
    markedCount: first.markedCount,
    summary: await service.summary(actor),
  });
  expect((await invoke()).summary.total).toBe(2);
  await changeNotifyMessageAccessFixture(prisma, clock, {
    merchantUserId: own.user.id,
    entityId: own.entity.id,
    storeId: second.id,
    change: "archive_store",
  });
  const cropped = await invoke();
  expect(cropped).toEqual({
    markedCount: first.markedCount,
    summary: await service.summary(actor),
  });
  expect(cropped.summary).toMatchObject({
    total: 1,
    byStore: [{ storeId: own.store.id, unreadCount: 1 }],
  });
  for (const row of [other, newer])
    expect(
      (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: row.id } })).readAt,
    ).toBeNull();
});

it("账号无门店的同键重放在停用后单读404、批读摘要零，历史markedCount与DML保持", async () => {
  const user = await make.merchantUser();
  const actor = { merchantUserId: user.id, storeId: null };
  const upper = await createNotifyMessageFixture(prisma, clock, { merchantUserId: user.id });
  const single = await createNotifyMessageFixture(prisma, clock, { merchantUserId: user.id });
  const pending = await createNotifyMessageFixture(prisma, clock, { merchantUserId: user.id });
  const readKey = uuidv7(),
    batchKey = uuidv7();
  const firstRead = await service.read(
    actor,
    single.id,
    replayOptions(actor, "read", single.id, readKey),
  );
  const body = { upToMessageId: upper.id, tab: "all" as const };
  const firstBatch = await service.batchRead(
    actor,
    body,
    replayOptions(actor, "batchRead", upper.id, batchKey),
  );
  expect(firstBatch).toMatchObject({ markedCount: 1, summary: { total: 1 } });
  await prisma.merchantUser.update({ where: { id: user.id }, data: { status: "disabled" } });
  await expect(
    service.read(actor, single.id, replayOptions(actor, "read", single.id, readKey)),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  const replay = await service.batchRead(
    actor,
    body,
    replayOptions(actor, "batchRead", upper.id, batchKey),
  );
  expect(replay).toEqual({
    markedCount: firstBatch.markedCount,
    summary: await service.summary(actor),
  });
  expect(replay.summary).toMatchObject({ total: 0, byStore: [] });
  expect(
    (
      await prisma.merchantMessage.findUniqueOrThrow({ where: { id: single.id } })
    ).readAt?.toISOString(),
  ).toBe(firstRead.readAt);
  expect(
    (await prisma.merchantMessage.findUniqueOrThrow({ where: { id: pending.id } })).readAt,
  ).toBeNull();
});
