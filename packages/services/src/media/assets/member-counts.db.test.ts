import type { Prisma } from "@liyoxi/db";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createTxRunner, uuidv7 } from "../../kernel/index.js";
import {
  createClock,
  createFactories,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import type { FactoryDb } from "../../testing/index.js";
import { readMemberAssetCounts } from "../index.js";

const db = useSeededDatabase("services", { max: 1 });
const clock = createClock();
const SLOW = 60_000;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let runner: ReturnType<typeof createTxRunner>;

beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  runner = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);

type Scope = { entity: { id: string }; store: { id: string } };
const input = (scope: Scope, merchantUserIds: readonly string[]) => ({
  entityId: scope.entity.id,
  storeId: scope.store.id,
  merchantUserIds,
});

// 仅建立合法历史统计事实，不宣称执行了上传、采用、复核或邀请的 producer。
function asset(
  scope: Scope,
  userId: string,
  extra: Partial<Prisma.StoreAssetCreateManyInput> = {},
  handle: FactoryDb = prisma,
) {
  const now = clock.now();
  return handle.storeAsset.create({
    data: {
      id: uuidv7(),
      entityId: scope.entity.id,
      storeId: scope.store.id,
      type: "text",
      textBody: "成员素材条数的虚构历史样例",
      uploadActorType: "merchant",
      uploadActorId: userId,
      uploadActorRole: "owner",
      uploadClient: "weapp",
      processingState: "pending",
      reviewState: "unreviewed",
      adoptedCount: 0,
      idempotencyKey: uuidv7(),
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  });
}

describe("成员素材历史条数：真实同事务批量读口", () => {
  it(
    "空目标返回空 Map，读口不发送 SQL",
    async () => {
      const world = await make.merchant();
      await runner.run(async (tx) => {
        const tagged = vi.spyOn(tx, "$queryRaw");
        const unsafe = vi.spyOn(tx, "$queryRawUnsafe");
        try {
          expect(await readMemberAssetCounts(tx, input(world, []))).toEqual(new Map());
          expect(tagged).not.toHaveBeenCalled();
          expect(unsafe).not.toHaveBeenCalled();
        } finally {
          tagged.mockRestore();
          unsafe.mockRestore();
        }
      });
    },
    SLOW,
  );

  it(
    "真实无匹配行仍为每个目标返回两个整数零",
    async () => {
      const world = await make.merchant();
      const other = await make.merchantUser();
      const counts = await runner.run((tx) =>
        readMemberAssetCounts(tx, input(world, [world.user.id, other.id])),
      );
      expect(counts.size).toBe(2);
      for (const id of [world.user.id, other.id])
        expect(counts.get(id)).toEqual({ uploadCount: 0, adoptedCount: 0 });
    },
    SLOW,
  );

  it(
    "一批不同账号各自聚合，未请求账号不进入结果",
    async () => {
      const world = await make.merchant();
      const second = await make.merchantUser();
      const absent = await make.merchantUser();
      const unrequested = await make.merchantUser();
      await asset(world, world.user.id, { adoptedCount: 1 });
      await asset(world, world.user.id);
      await asset(world, second.id, { adoptedCount: 7 });
      await asset(world, unrequested.id, { adoptedCount: 1 });
      const counts = await runner.run((tx) =>
        readMemberAssetCounts(tx, input(world, [world.user.id, second.id, absent.id])),
      );
      expect(counts.size).toBe(3);
      expect(counts.get(world.user.id)).toEqual({ uploadCount: 2, adoptedCount: 1 });
      expect(counts.get(second.id)).toEqual({ uploadCount: 1, adoptedCount: 1 });
      expect(counts.get(absent.id)).toEqual({ uploadCount: 0, adoptedCount: 0 });
      expect(counts.has(unrequested.id)).toBe(false);
    },
    SLOW,
  );

  it(
    "采用数统计 adoptedCount 大于零的条数，不累加采用次数",
    async () => {
      const world = await make.merchant();
      for (const adoptedCount of [0, 1, 7]) await asset(world, world.user.id, { adoptedCount });
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 3, adoptedCount: 2 }]]));
    },
    SLOW,
  );

  it(
    "重复账号只返回一个结果，不修改调用方的只读数组",
    async () => {
      const world = await make.merchant();
      await asset(world, world.user.id, { adoptedCount: 1 });
      const ids = Object.freeze([world.user.id, world.user.id, world.user.id]);
      expect(await runner.run((tx) => readMemberAssetCounts(tx, input(world, ids)))).toEqual(
        new Map([[world.user.id, { uploadCount: 1, adoptedCount: 1 }]]),
      );
      expect(ids).toEqual([world.user.id, world.user.id, world.user.id]);
    },
    SLOW,
  );

  it.each(["同主体其他门店", "其他主体", "主体门店错配"] as const)(
    "%s 的相同上传账号不能串入当前统计",
    async (kind) => {
      const world = await make.merchant();
      const other =
        kind === "同主体其他门店"
          ? { entity: world.entity, store: await make.store({ entityId: world.entity.id }) }
          : await make.merchant();
      await asset(world, world.user.id);
      await asset(other, world.user.id, { adoptedCount: 7 });
      await asset(other, world.user.id, { adoptedCount: 1 });
      const scope = kind === "主体门店错配" ? { entity: world.entity, store: other.store } : world;
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(scope, [world.user.id]))),
      ).toEqual(
        new Map([
          [world.user.id, { uploadCount: kind === "主体门店错配" ? 0 : 1, adoptedCount: 0 }],
        ]),
      );
    },
    SLOW,
  );

  it(
    "合法员工代传不算商家上传，即使多态操作人的 UUID 相同",
    async () => {
      const world = await make.merchant();
      // 不同表可有同 UUID；用真实员工行验证 uploader 类型判别，而非靠 ID 不同排除。
      const staff = await make.staff({ id: world.user.id });
      await asset(world, world.user.id);
      await asset(world, staff.id, {
        uploadActorType: "staff",
        uploadActorRole: null,
        uploadClient: "admin",
        adoptedCount: 7,
      });
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 1, adoptedCount: 0 }]]));
    },
    SLOW,
  );

  it(
    "软删除素材同时排除上传数和采用条数",
    async () => {
      const world = await make.merchant();
      await asset(world, world.user.id);
      await asset(world, world.user.id, { deletedAt: clock.now(), adoptedCount: 7 });
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 1, adoptedCount: 0 }]]));
    },
    SLOW,
  );

  it.each(["pending", "processing", "processed"] as const)(
    "%s 处理状态不裁掉历史上传或已采用素材",
    async (processingState) => {
      const world = await make.merchant();
      await asset(world, world.user.id, { processingState });
      await asset(world, world.user.id, { processingState, adoptedCount: 7 });
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 2, adoptedCount: 1 }]]));
    },
    SLOW,
  );

  it(
    "已复核需重拍且安全拦截的素材仍按历史条数计入",
    async () => {
      const world = await make.merchant();
      const reviewer = await make.staff();
      await asset(world, world.user.id, {
        processingState: "processed",
        reviewState: "reviewed",
        usability: "need_reshoot",
        reviewedByStaffId: reviewer.id,
        reviewedAt: clock.now(),
        moderationState: "block",
        adoptedCount: 7,
      });
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 1, adoptedCount: 1 }]]));
    },
    SLOW,
  );

  it(
    "上传者已离开主体，其历史素材不依赖当前有效 membership",
    async () => {
      const world = await make.merchant();
      const former = await make.merchantUser();
      const member = await make.entityMember({
        entityId: world.entity.id,
        merchantUserId: former.id,
        status: "removed",
        removedAt: clock.now(),
        removeReason: "self",
        removeActorType: "merchant",
        removeActorId: former.id,
        removeClient: "weapp",
        lastStoreId: null,
      });
      await asset(world, former.id, { uploadActorRole: "clerk", adoptedCount: 7 });
      expect(await prisma.storeMember.count({ where: { entityMemberId: member.id } })).toBe(0);
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [former.id]))),
      ).toEqual(new Map([[former.id, { uploadCount: 1, adoptedCount: 1 }]]));
    },
    SLOW,
  );

  it(
    "真实批量只发一个参数绑定的标记 SQL，两值来自同一查询",
    async () => {
      const world = await make.merchant();
      const second = await make.merchantUser();
      await asset(world, world.user.id, { adoptedCount: 1 });
      await runner.run(async (tx) => {
        const select = vi.spyOn(tx, "$queryRaw");
        const unsafe = vi.spyOn(tx, "$queryRawUnsafe");
        try {
          const counts = await readMemberAssetCounts(tx, input(world, [world.user.id, second.id]));
          expect(counts.get(world.user.id)).toEqual({ uploadCount: 1, adoptedCount: 1 });
          expect(counts.get(second.id)).toEqual({ uploadCount: 0, adoptedCount: 0 });
          expect(select).toHaveBeenCalledOnce();
          expect(unsafe).not.toHaveBeenCalled();
          const [strings, ...values] = select.mock.calls[0]!;
          if (!Array.isArray(strings)) throw new Error("成员计数须使用绑定参数的标记 SQL");
          const sql = strings.join("?");
          expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|FOR\s+UPDATE)\b/iu);
          for (const id of [world.entity.id, world.store.id, world.user.id, second.id])
            expect(sql).not.toContain(id);
          expect(values).toContainEqual([world.user.id, second.id]);
          expect(values).toContain(world.entity.id);
          expect(values).toContain(world.store.id);
        } finally {
          select.mockRestore();
          unsafe.mockRestore();
        }
      });
    },
    SLOW,
  );

  it(
    "同 Tx 看见未提交增改，读口不旁写，外层回滚恢复原始事实",
    async () => {
      const world = await make.merchant();
      const existing = await asset(world, world.user.id);
      const tables = [
        "store_asset",
        "store_asset_usage",
        "audit_log",
        "outbox_event",
        "status_transition",
      ];
      const before = await snapshotTables(prisma, tables);
      const failure = new Error("成员素材统计的外层回滚");
      await expect(
        runner.run(async (tx) => {
          await asset(world, world.user.id, { adoptedCount: 7 }, tx);
          await tx.storeAsset.update({ where: { id: existing.id }, data: { adoptedCount: 1 } });
          const beforeRead = await snapshotTables(tx, tables);
          expect(await readMemberAssetCounts(tx, input(world, [world.user.id]))).toEqual(
            new Map([[world.user.id, { uploadCount: 2, adoptedCount: 2 }]]),
          );
          expect(await snapshotTables(tx, tables)).toEqual(beforeRead);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(
        await runner.run((tx) => readMemberAssetCounts(tx, input(world, [world.user.id]))),
      ).toEqual(new Map([[world.user.id, { uploadCount: 1, adoptedCount: 0 }]]));
    },
    SLOW,
  );

  it(
    "SQL 失败原样抛出，不伪装成真实零计数",
    async () => {
      const world = await make.merchant();
      const failure = new Error("成员计数 SQL 故障");
      await expect(
        runner.run(async (tx) => {
          const select = vi.spyOn(tx, "$queryRaw").mockRejectedValueOnce(failure);
          try {
            return await readMemberAssetCounts(tx, input(world, [world.user.id]));
          } finally {
            select.mockRestore();
          }
        }),
      ).rejects.toBe(failure);
    },
    SLOW,
  );
});
