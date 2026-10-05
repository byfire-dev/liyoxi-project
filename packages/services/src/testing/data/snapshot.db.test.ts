// 表快照比较器的连库用例（任务书 W0-25 第 7 节第 4 条）：对着真库记快照，增、删、改各报得出。
import { describe, expect, it } from "vitest";

import { createTxRunner } from "../../kernel/index.js";
import {
  assertSnapshotsEqual,
  createClock,
  createFactories,
  diffSnapshots,
  snapshotTables,
  useSeededDatabase,
} from "../index.js";

const db = useSeededDatabase("services");
const TIMEOUT = { timeout: 120_000 };
const clock = createClock();
const TABLES = ["store", "merchant_user", "entity"] as const;

describe("snapshotTables", () => {
  it("规整：按主键认行、按键排序；时间、bytea、数组都是可比较的写法", TIMEOUT, async () => {
    const prisma = await db.prisma();
    const make = createFactories({ db: prisma, clock });
    const drama = await make.drama({ genreCodes: ["G02", "G01"], roles: [{ name: "女主" }] });
    const user = await make.merchantUser();

    const snapshot = await snapshotTables(prisma, ["merchant_user", "drama", "drama"]);
    expect(Object.keys(snapshot)).toEqual(["drama", "merchant_user"]);
    expect(snapshot.drama?.keyColumns).toEqual(["id"]);
    const row = snapshot.drama?.rows.find((item) => item.id === drama.id);
    expect(row).toMatchObject({
      title: drama.title,
      status: "listed",
      genre_codes: ["G02", "G01"],
      roles: [{ name: "女主" }],
      total_episodes: 3,
      poster_file_id: null,
    });
    // 时间是带时区的文本（按会话时区写），解析回来是同一刻
    expect(typeof row?.created_at).toBe("string");
    expect(new Date(String(row?.created_at)).toISOString()).toBe(clock.now().toISOString());
    const stored = snapshot.merchant_user?.rows.find((item) => item.id === user.id);
    expect(stored?.phone_bidx).toBe(`\\x${Buffer.from(user.phoneBidx ?? []).toString("hex")}`);
    // 行按键排好序：同一刻再记一遍，两张快照直接相等
    expect(await snapshotTables(prisma, ["drama", "merchant_user"])).toEqual(snapshot);
  });

  it("增、删、改各报得出；忽略的列变了不报；没变时为空", TIMEOUT, async () => {
    const prisma = await db.prisma();
    const make = createFactories({ db: prisma, clock });
    const kept = await make.store();
    const gone = await make.store({ entityId: kept.entityId });
    const before = await snapshotTables(prisma, TABLES);
    assertSnapshotsEqual(before, await snapshotTables(prisma, TABLES));

    clock.advance(60_000);
    const added = await make.store({ entityId: kept.entityId });
    await prisma.store.update({
      where: { id: kept.id },
      data: { name: "改过名的店", updatedAt: clock.now() },
    });
    await prisma.store.delete({ where: { id: gone.id } });
    const after = await snapshotTables(prisma, TABLES);

    const diff = diffSnapshots(before, after);
    expect(diff.tables.map((item) => item.table)).toEqual(["store"]);
    const [stores] = diff.tables;
    expect(stores?.added.map((row) => row.id)).toEqual([added.id]);
    expect(stores?.removed.map((row) => row.id)).toEqual([gone.id]);
    expect(stores?.changed.map((item) => [item.key, item.columns])).toEqual([
      [{ id: kept.id }, ["name", "updated_at"]],
    ]);
    expect(stores?.changed[0]?.after.name).toBe("改过名的店");

    const ignoring = diffSnapshots(before, after, { ignore: { store: ["name", "updated_at"] } });
    expect(ignoring.tables[0]?.changed).toEqual([]);
    expect(ignoring.tables[0]?.added).toHaveLength(1);
    expect(() => assertSnapshotsEqual(before, after)).toThrow(/store：增 1 行，删 1 行，改 1 行/);
  });

  it("换认行的列：按业务键认行（回放测试里主键每次不同时用）", TIMEOUT, async () => {
    const prisma = await db.prisma();
    const byCode = await snapshotTables(prisma, ["plan"], { keyBy: { plan: ["code"] } });
    expect(byCode.plan?.keyColumns).toEqual(["code"]);
    expect(byCode.plan?.rows.map((row) => row.code)).toEqual(["basic", "flagship", "pro"]);
    // 认行的列不唯一、没有这一列，都抛错
    await expect(snapshotTables(prisma, ["plan"], { keyBy: { plan: ["scope"] } })).rejects.toThrow(
      /认行不唯一/,
    );
    await expect(
      snapshotTables(prisma, ["plan"], { keyBy: { plan: ["no_such"] } }),
    ).rejects.toThrow("plan 没有 no_such 这一列");
  });

  it("可以在事务里记：看得到本事务还没提交的行", TIMEOUT, async () => {
    const prisma = await db.prisma();
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const before = await snapshotTables(prisma, ["staff"]);
    await expect(
      tx.run(async (handle) => {
        await createFactories({ db: handle, clock }).staff();
        const inside = await snapshotTables(handle, ["staff"]);
        expect(diffSnapshots(before, inside).tables[0]?.added).toHaveLength(1);
        throw new Error("回滚");
      }),
    ).rejects.toThrow("回滚");
    assertSnapshotsEqual(before, await snapshotTables(prisma, ["staff"]));
  });

  it("表名只收标识符，且要在库里：写错即抛错，不拼进 SQL", TIMEOUT, async () => {
    const prisma = await db.prisma();
    await expect(snapshotTables(prisma, ['store"; DROP TABLE store; --'])).rejects.toThrow(
      /表名只收/,
    );
    await expect(snapshotTables(prisma, ["Store"])).rejects.toThrow(/表名只收/);
    await expect(snapshotTables(prisma, ["no_such_table"])).rejects.toThrow(
      "库里没有这张表：no_such_table",
    );
  });
});
