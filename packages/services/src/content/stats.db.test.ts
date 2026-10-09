import { expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  assembleForTest,
  useSeededDatabase,
} from "../testing/index.js";
import { DramaUsagePort } from "./ports.js";
const db = useSeededDatabase("services");
it("真实公开用量端口按上海月界/30自然日及当前live汇总，不存在的剧给真实0", async () => {
  const prisma = await db.prisma(),
    clock = createClock();
  clock.set(new Date("2026-03-01T00:00:00Z"));
  const make = createFactories({ db: prisma, clock }),
    drama = await make.drama();
  const current = await make.orderItem({ dramaId: drama.id, phase: "live" });
  const older = await make.orderItem({ dramaId: drama.id, phase: "live" });
  await prisma.dramaOrder.update({
    where: { id: older.dramaOrderId },
    data: {
      submittedAt: new Date("2026-02-01T00:00:00Z"),
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
  });
  const tx = createTxRunner({ prisma, appEnv: "test" }),
    usage = assembleForTest({ entry: "worker" }).port(DramaUsagePort);
  expect((await tx.run((t) => usage.stats(t, [drama.id], clock.now()))).get(drama.id)).toEqual({
    orders30d: 2,
    ordersMtd: 1,
    liveItems: 2,
  });
  expect(await tx.run((t) => usage.hasOpenItems(t, drama.id))).toBe(true);
  expect(current.dramaId).toBe(drama.id);
});
