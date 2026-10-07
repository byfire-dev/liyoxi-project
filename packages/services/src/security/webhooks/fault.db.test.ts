import { it, expect, beforeAll } from "vitest";
import {
  connectTestDatabase,
  createSampleEvents,
  sampleSystemContext,
  useTestDatabase,
} from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import { count, prepare, source, write } from "./__fixtures__/source.js";
const db = useTestDatabase("services");
beforeAll(async () => {
  await db.prisma();
  const owner = await connectTestDatabase(db.name, { role: null });
  try {
    await owner.query(
      "CREATE TABLE lyx_probe_webhook_commit (id integer PRIMARY KEY, n integer NOT NULL, UNIQUE(n) DEFERRABLE INITIALLY DEFERRED); GRANT SELECT,INSERT ON lyx_probe_webhook_commit TO lyx_app; INSERT INTO lyx_probe_webhook_commit VALUES(1,1)",
    );
  } finally {
    await owner.end();
  }
}, 120_000);
it("inline每句成功但真实COMMIT延迟约束失败：应答失败，领域写/收件均无假processed", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  let reachedEnd = false;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      source("WF", {
        mode: "inline",
        handle: async (tx) => {
          await write(tx, "WF");
          await tx.$executeRawUnsafe("INSERT INTO lyx_probe_webhook_commit VALUES(2,1)");
          reachedEnd = true;
          return "processed";
        },
      }),
    ],
  });
  expect(
    (await hooks.accept(await prepare(hooks, "commit-fault"), sampleSystemContext())).status,
  ).toBe(500);
  expect(reachedEnd).toBe(true);
  expect(await count(prisma, "WF")).toBe(0);
  expect(await prisma.webhookEvent.count({ where: { eventId: "commit-fault" } })).toBe(0);
}, 120_000);
it("inbox领域真实约束异常：保存点清除领域写，收件锁仍能写失败记录并恢复", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  let broken = true;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      source("WK", {
        handle: async (tx) => {
          await write(tx, "WK");
          if (broken)
            await tx.$executeRawUnsafe("INSERT INTO lyx_probe_webhook_commit VALUES(1,2)");
          return "processed";
        },
      }),
    ],
  });
  await hooks.accept(await prepare(hooks, "constraint-fault"), sampleSystemContext());
  expect(await hooks.scan()).toBe(1);
  expect(await count(prisma, "WK")).toBe(0);
  expect(
    await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "constraint-fault" } }),
  ).toMatchObject({ processState: "failed", attempts: 1, error: "WEBHOOK_HANDLER_FAILED" });
  broken = false;
  sample.clock.advance(60000);
  expect(await hooks.scan()).toBe(1);
  expect(await count(prisma, "WK")).toBe(1);
}, 120_000);
it("真实40001回滚后tx.run重试：不能计入业务失败attempts", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  let called = 0;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      source("WQ", {
        handle: async (tx) => {
          await write(tx, "WQ");
          called++;
          if (called === 1)
            await tx.$executeRawUnsafe(
              "DO $$ BEGIN RAISE EXCEPTION 'fixture serialization failure' USING ERRCODE='40001'; END $$",
            );
          return "processed";
        },
      }),
    ],
  });
  await hooks.accept(await prepare(hooks, "retryable-fault"), sampleSystemContext());
  expect(await hooks.scan()).toBe(1);
  expect(called).toBe(2);
  expect(await count(prisma, "WQ")).toBe(1);
  expect(
    await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "retryable-fault" } }),
  ).toMatchObject({ processState: "processed", attempts: 0, error: null });
}, 120_000);
