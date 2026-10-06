import { createPrismaClient } from "@liyoxi/db";
import { crashPoint, createClock } from "../../testing/index.js";
import { runTimer } from "../../timers/index.js";
import { startHarness } from "./start-harness.js";

/** 仅父用例的私有数据库；断在真实 capture 完成、同一开工事务提交之前。 */
export default async function scenario(input: {
  databaseUrl: string;
  now: string;
  timerId: string;
}) {
  if (!new URL(input.databaseUrl).pathname.startsWith("/lyx_test_"))
    throw new Error("开工中断夹具只能连接自己的测试库");
  const prisma = createPrismaClient({ connectionString: input.databaseUrl, max: 1 });
  const h = startHarness(prisma, {
    clock: createClock(new Date(input.now)),
    onStep: async (step) => {
      if (step === "event.emit") await crashPoint("capture-complete");
    },
  });
  try {
    await runTimer(
      { ...h.deps, registry: h.deps.timers.registry, alerts: { raise: async () => {} } },
      { timerId: input.timerId, kind: "order.start", dispatchNo: 1 },
    );
  } finally {
    h.clear();
    await prisma.$disconnect();
  }
}
