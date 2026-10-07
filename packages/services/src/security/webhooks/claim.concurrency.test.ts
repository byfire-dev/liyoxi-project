import { createPrismaClient } from "@liyoxi/db";
import { it, expect } from "vitest";
import { createTxRunner, uuidv7 } from "../../kernel/index.js";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import { count, prepare, source, write } from "./__fixtures__/source.js";
const db = useTestDatabase("services");
it("两进程扫描SKIP LOCKED：占住最早收件时另一方恰好50条，每行一次领域提交", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  const other = createPrismaClient({ connectionString: await db.url(), max: 1 });
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => {
    entered = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const input = source("WH", {
    handle: async (tx) => {
      if (first) {
        first = false;
        entered();
        await released;
      }
      await write(tx, "WH");
      return "processed";
    },
  });
  const left = createWebhooks({ ...sample, sources: [input] }),
    right = createWebhooks({
      ...sample,
      tx: createTxRunner({ prisma: other, appEnv: "test" }),
      sources: [input],
    });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      const id = uuidv7();
      ids.push(id);
      await left.accept(await prepare(left, id), sampleSystemContext());
      sample.clock.advance(1);
    }
    const pending = left.scan();
    await held;
    const rows = await prisma.webhookEvent.findMany({
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    });
    try {
      expect(await right.scan()).toBe(50);
      expect(await prisma.webhookEvent.count({ where: { processState: "processed" } })).toBe(50);
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: rows[0]!.id } })).processState,
      ).toBe("received");
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: rows[51]!.id } })).processState,
      ).toBe("received");
      expect(await count(prisma, "WH")).toBe(50);
    } finally {
      release();
    }
    expect(await pending).toBe(3);
    expect(await count(prisma, "WH")).toBe(53);
    expect(
      await prisma.webhookEvent.count({
        where: { eventId: { in: ids }, processState: "processed" },
      }),
    ).toBe(53);
    expect(await right.scan()).toBe(0);
  } finally {
    release();
    await other.$disconnect();
  }
}, 120_000);
