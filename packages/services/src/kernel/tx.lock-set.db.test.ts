import { beforeAll, expect, it } from "vitest";
import { useTestDatabase } from "../testing/index.js";
import { put, rows, bump, gate, openClient } from "./__fixtures__/db.js";
import { merchant, requestOf } from "./__fixtures__/idempotency.js";
import { AppError } from "./errors.js";
import { createTxRunner, LockSetChanged } from "./tx.js";

const db = useTestDatabase("services");
beforeAll(async () => {
  await db.prisma();
}, 120_000);

it("两连接间锁图变化整事务重试，已写行回滚且同一幂等请求只保存一次结果", async () => {
  const prisma = await db.prisma(),
    left = await openClient(db);
  const tx = createTxRunner({ prisma: left, appEnv: "test" });
  const actor = merchant(),
    idem = requestOf(actor, "lockset:success", {}, { scope: "m.ad.confirm" });
  await put(prisma, "LG");
  const prepared = gate(),
    changed = gate();
  let attempts = 0;
  const work = tx.run(
    async (handle) => {
      attempts++;
      const before = (await rows(handle)).LG;
      if (attempts === 1) {
        prepared.open();
        await changed.opened;
      }
      await handle.$queryRaw`SELECT prefix FROM biz_sequence WHERE prefix='LG' FOR UPDATE`;
      const after = (await rows(handle)).LG;
      await put(handle, "LA");
      if (before !== after) throw new LockSetChanged();
      return { versionNo: after };
    },
    { idem },
  );
  try {
    await Promise.race([prepared.opened, work.then(() => undefined)]);
    // Another connection commits between the pre-read and lock acquisition; no timing sleep.
    await bump(prisma, "LG");
    changed.open();
    const result = await work;
    expect(attempts).toBe(2);
    expect(result).toEqual({ versionNo: 2 });
    expect(await rows(prisma)).toMatchObject({ LA: 1, LG: 2 });
    expect(await prisma.idempotencyRecord.count({ where: { key: "lockset:success" } })).toBe(1);
    const replay = requestOf(actor, "lockset:success", {}, { scope: "m.ad.confirm" });
    expect(
      await tx.run(
        async () => {
          throw new Error("重放不得再执行业务");
        },
        { idem: replay },
      ),
    ).toEqual(result);
    expect(replay.replayed).toBe(true);
  } finally {
    changed.open();
    await work.catch(() => undefined);
    await left.$disconnect();
  }
});

it("锁集合持续变化仍只重试一次，返回BUSY并回滚；普通前置失败不重试", async () => {
  const prisma = await db.prisma(),
    tx = createTxRunner({ prisma, appEnv: "test" });
  const actor = merchant();
  let attempts = 0;
  await expect(
    tx.run(
      async (handle) => {
        attempts++;
        await put(handle, "LB");
        throw new LockSetChanged();
      },
      { idem: requestOf(actor, "lockset:busy", {}, { scope: "m.ad.confirm" }) },
    ),
  ).rejects.toMatchObject({ error: "BUSY" });
  expect(attempts).toBe(2);
  expect(await rows(prisma)).not.toHaveProperty("LB");
  expect(await prisma.idempotencyRecord.count({ where: { key: "lockset:busy" } })).toBe(0);
  let businessAttempts = 0;
  await expect(
    tx.run(async () => {
      businessAttempts++;
      throw new AppError("PRECONDITION_CHANGED");
    }),
  ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
  expect(businessAttempts).toBe(1);
});
