// W1-13：独立 worker 装配不依赖 API 工厂的进程全局绑定。
import { it, expect } from "vitest";
import {
  useSeededDatabase,
  createClock,
  assembleForTest,
  createProviderHarness,
  createFactories,
} from "../testing/index.js";
import { createContent, seedDemoContent, bindContent } from "../content/index.js";
import { createTxRunner } from "../kernel/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createMedia } from "../media/index.js";
import { buildWorkerServices } from "./worker.js";
import { runInvariants } from "./invariants/index.js";
const db = useSeededDatabase("services"),
  clock = createClock();
it("真实worker装配执行content全量六项，3部listed剧没有未绑定失败", async () => {
  const prisma = await db.prisma(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    providers = createProviderHarness({ clock }).providers,
    media = createMedia({ tx, clock, assembly, events, storage: providers.storage }),
    content = createContent({ clock, assembly, flow, media }),
    staff = await createFactories({ db: prisma, clock }).staff({ staffRoleKey: "content_ops" });
  const clear = bindContent(assembly);
  clear();
  try {
    await seedDemoContent({ tx, clock, content, media, appEnv: "test" }, staff.id);
    const i1 = assembly.invariant("content.I1")!;
    await expect(tx.run((t) => i1.run!(t, {}, { now: clock.now() }))).rejects.toThrow("未绑定装配");
    const worker = buildWorkerServices({
      appEnv: "test",
      prisma,
      assembly,
      clock,
      providers,
      channel: { enqueue: async () => {}, downForMs: () => 0 },
    });
    const result = await runInvariants(
      { tx, assembly: worker.assembly, clock },
      { mode: "full", trigger: "manual", modules: ["content"] },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      checksRun: 6,
      violationsFound: 0,
      errors: [],
    });
  } finally {
    clear();
  }
}, 180000);
