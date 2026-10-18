import type { Prisma } from "@liyoxi/db";
import { beforeAll, expect, it, vi } from "vitest";
import { createTxRunner, uuidv7 } from "../../kernel/index.js";
import {
  createClock,
  createFactories,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import type { FactoryDb } from "../../testing/index.js";
import { readEntityAssetCounts } from "../index.js";

const db = useSeededDatabase("services", { max: 1 }),
  clock = createClock();
const SLOW = 120_000;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>, runner: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  runner = createTxRunner({ prisma, appEnv: "test" });
}, SLOW);
type Scope = { entity: { id: string }; store: { id: string } };
// 合法历史素材，只验读口；不冒称调用了上传、复制或采用 producer。
function asset(
  scope: Scope,
  userId: string,
  extra: Partial<Prisma.StoreAssetCreateManyInput> = {},
  handle: FactoryDb = prisma,
) {
  return handle.storeAsset.create({
    data: {
      id: uuidv7(),
      entityId: scope.entity.id,
      storeId: scope.store.id,
      type: "text",
      textBody: "后台统计虚构历史素材",
      uploadActorType: "merchant",
      uploadActorId: userId,
      uploadActorRole: "owner",
      uploadClient: "weapp",
      processingState: "pending",
      reviewState: "unreviewed",
      adoptedCount: 0,
      idempotencyKey: uuidv7(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...extra,
    },
  });
}
const read = (entityId: string, storeIds: readonly string[], merchantUserIds: readonly string[]) =>
  runner.run((tx) => readEntityAssetCounts(tx, { entityId, storeIds, merchantUserIds }));

it(
  "双空数组无SQL且不冒称主体存在；空聚合为每个唯一目标返回真实零",
  async () => {
    await runner.run(async (tx) => {
      const tagged = vi.spyOn(tx, "$queryRaw"),
        unsafe = vi.spyOn(tx, "$queryRawUnsafe");
      try {
        expect(
          await readEntityAssetCounts(tx, {
            entityId: uuidv7(),
            storeIds: [],
            merchantUserIds: [],
          }),
        ).toEqual({ stores: new Map(), members: new Map() });
        expect(tagged).not.toHaveBeenCalled();
        expect(unsafe).not.toHaveBeenCalled();
      } finally {
        tagged.mockRestore();
        unsafe.mockRestore();
      }
    });
    const world = await make.merchant();
    expect(await read(world.entity.id, [world.store.id], [world.user.id])).toEqual({
      stores: new Map([
        [world.store.id, { assetCount: 0, reviewedAssetCount: 0, copiedAssetCount: 0 }],
      ]),
      members: new Map([[world.user.id, { uploadedAssetCount: 0, adoptedAssetCount: 0 }]]),
    });
  },
  SLOW,
);

it(
  "一条真实参数化SQL同时汇总门店与全主体账号，重复目标不膨胀",
  async () => {
    const world = await make.merchant(),
      second = await make.store({ entityId: world.entity.id });
    const reviewer = await make.staff(),
      source = await asset(world, world.user.id);
    await asset(world, world.user.id, {
      reviewState: "reviewed",
      usability: "ready",
      reviewedByStaffId: reviewer.id,
      reviewedAt: clock.now(),
      adoptedCount: 7,
      sourceStoreAssetId: source.id,
    });
    await asset({ entity: world.entity, store: second }, world.user.id, { adoptedCount: 1 });
    await runner.run(async (tx) => {
      const tagged = vi.spyOn(tx, "$queryRaw"),
        unsafe = vi.spyOn(tx, "$queryRawUnsafe");
      try {
        const storeIds = Object.freeze([world.store.id, world.store.id]);
        const userIds = Object.freeze([world.user.id, world.user.id]);
        expect(
          await readEntityAssetCounts(tx, {
            entityId: world.entity.id,
            storeIds,
            merchantUserIds: userIds,
          }),
        ).toEqual({
          stores: new Map([
            [world.store.id, { assetCount: 2, reviewedAssetCount: 1, copiedAssetCount: 1 }],
          ]),
          members: new Map([[world.user.id, { uploadedAssetCount: 3, adoptedAssetCount: 2 }]]),
        });
        expect(tagged).toHaveBeenCalledTimes(1);
        expect(unsafe).not.toHaveBeenCalled();
        expect(storeIds).toEqual([world.store.id, world.store.id]);
        expect(userIds).toEqual([world.user.id, world.user.id]);
      } finally {
        tagged.mockRestore();
        unsafe.mockRestore();
      }
    });
  },
  SLOW,
);

it.each(["foreign", "missing"] as const)(
  "%s 门店使整批NOT_FOUND，不泄露部分统计",
  async (kind) => {
    const world = await make.merchant(),
      other = await make.merchant();
    await asset(world, world.user.id);
    await expect(
      read(
        world.entity.id,
        [world.store.id, kind === "foreign" ? other.store.id : uuidv7()],
        [world.user.id],
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  },
  SLOW,
);

it(
  "员工上传仍计门店但不计商家，同UUID多态身份及软删除严格区分",
  async () => {
    const world = await make.merchant(),
      staff = await make.staff({ id: world.user.id });
    await asset(world, world.user.id);
    await asset(world, staff.id, {
      uploadActorType: "staff",
      uploadActorRole: null,
      uploadClient: "admin",
      adoptedCount: 7,
    });
    await asset(world, world.user.id, { deletedAt: clock.now(), adoptedCount: 7 });
    const other = await make.merchant();
    await asset(other, world.user.id, { adoptedCount: 7 });
    expect(await read(world.entity.id, [world.store.id], [world.user.id])).toEqual({
      stores: new Map([
        [world.store.id, { assetCount: 2, reviewedAssetCount: 0, copiedAssetCount: 0 }],
      ]),
      members: new Map([[world.user.id, { uploadedAssetCount: 1, adoptedAssetCount: 0 }]]),
    });
  },
  SLOW,
);

it(
  "归档店、已移除成员、处理及安全状态不裁历史；采用只计条数",
  async () => {
    const world = await make.merchant(),
      former = await make.merchantUser(),
      reviewer = await make.staff();
    const store = await make.store({
      entityId: world.entity.id,
      lifecycle: "archived",
      archivedAt: clock.now(),
      archiveActorType: "merchant",
      archiveActorId: world.user.id,
      archiveClient: "weapp",
      archiveReason: "by_owner",
    });
    const member = await make.entityMember({
      entityId: world.entity.id,
      merchantUserId: former.id,
      status: "removed",
      removedAt: clock.now(),
      removeReason: "self",
      removeActorType: "merchant",
      removeActorId: former.id,
      removeClient: "weapp",
    });
    for (const processingState of ["pending", "processing", "processed"])
      await asset({ entity: world.entity, store }, former.id, {
        uploadActorRole: "clerk",
        processingState,
        adoptedCount: 7,
      });
    await asset({ entity: world.entity, store }, former.id, {
      uploadActorRole: "clerk",
      reviewState: "reviewed",
      usability: "need_reshoot",
      reviewedByStaffId: reviewer.id,
      reviewedAt: clock.now(),
      moderationState: "block",
      adoptedCount: 1,
    });
    expect(await prisma.storeMember.count({ where: { entityMemberId: member.id } })).toBe(0);
    expect(await read(world.entity.id, [store.id], [former.id])).toEqual({
      stores: new Map([[store.id, { assetCount: 4, reviewedAssetCount: 1, copiedAssetCount: 0 }]]),
      members: new Map([[former.id, { uploadedAssetCount: 4, adoptedAssetCount: 4 }]]),
    });
  },
  SLOW,
);

it(
  "两个维度可分别为空，不要求上传者仍有成员关系",
  async () => {
    const world = await make.merchant(),
      uploader = await make.merchantUser();
    await asset(world, uploader.id, { adoptedCount: 9 });
    expect(await read(world.entity.id, [], [uploader.id])).toEqual({
      stores: new Map(),
      members: new Map([[uploader.id, { uploadedAssetCount: 1, adoptedAssetCount: 1 }]]),
    });
    expect(await read(world.entity.id, [world.store.id], [])).toEqual({
      members: new Map(),
      stores: new Map([
        [world.store.id, { assetCount: 1, reviewedAssetCount: 0, copiedAssetCount: 0 }],
      ]),
    });
  },
  SLOW,
);

it(
  "同callerTx新素材立即可见、读口零写且外层回滚无旁写",
  async () => {
    const world = await make.merchant(),
      abort = new Error("统计事务回滚");
    const tables = [
      "store_asset",
      "entity_member",
      "store_member",
      "audit_log",
      "status_transition",
      "outbox_event",
    ];
    const before = await snapshotTables(prisma, tables);
    await expect(
      runner.run(async (tx) => {
        await asset(world, world.user.id, { adoptedCount: 7 }, tx);
        const inside = await snapshotTables(tx, tables);
        expect(
          await readEntityAssetCounts(tx, {
            entityId: world.entity.id,
            storeIds: [world.store.id],
            merchantUserIds: [world.user.id],
          }),
        ).toEqual({
          stores: new Map([
            [world.store.id, { assetCount: 1, reviewedAssetCount: 0, copiedAssetCount: 0 }],
          ]),
          members: new Map([[world.user.id, { uploadedAssetCount: 1, adoptedAssetCount: 1 }]]),
        });
        expect(await snapshotTables(tx, tables)).toEqual(inside);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  },
  SLOW,
);
