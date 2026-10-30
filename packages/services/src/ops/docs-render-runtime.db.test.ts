import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocsRenderRuntime } from "./docs-render-runtime.js";
import type { LicenseRenderingEngine } from "./docs-render-runtime.js";
import {
  createLicenseConvergenceFixture,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { reconcileLetters } from "../docs/index.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
let fixture: Fixture | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await fixture?.close();
  fixture = undefined;
});
async function fresh() {
  const f = (fixture = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  }));
  await f.start();
  await f.runtime.tx.run((tx) =>
    reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "runtime:render"),
  );
  const letter = await (
    await db.prisma()
  ).licenseLetter.findFirstOrThrow({
    where: { orderItemId: f.order.itemId },
    include: { revisions: true },
  });
  return { f, id: letter.revisions[0]!.id };
}
function scope(f: Fixture, engine?: LicenseRenderingEngine) {
  const runtime = createDocsRenderRuntime({
    tx: f.runtime.tx,
    clock: f.clock,
    convergence: f.licenseDeps,
    media: f.runtime.media,
    channel: { enqueue: async () => {} },
    ...(engine ? { engine } : {}),
    allowStamp: true,
  });
  closers.push(runtime.close);
  return runtime;
}

describe("授权书真实任务关闭边界", () => {
  it("未配置重复投递不认领、不消耗尝试、不生成文件", async () => {
    const { f, id } = await fresh(),
      runtime = scope(f);
    await runtime.process({ revisionId: id });
    await runtime.process({ revisionId: id });
    expect(
      await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ renderStatus: "queued", renderAttemptNo: 0, fileId: null });
  });
  it("关闭取消后等待实际签署收尾，依赖关闭晚于在途任务且不前移ready", async () => {
    const { f, id } = await fresh();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false,
      settled = false;
    const close = vi.fn(async () => {
      expect(settled).toBe(true);
    });
    const engine: LicenseRenderingEngine = {
      renderer: {
        configured: true,
        close: async () => {},
        render: async () => ({ ok: true, value: { pdf: Buffer.from("%PDF-1.7\n%%EOF") } }),
      },
      signer: {
        configured: true,
        status: "fake",
        seal: async (input) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          enter();
          await held;
          settled = true;
          return { ok: false, reason: "unavailable", message: "测试签署取消" };
        },
      },
      close,
    };
    const runtime = scope(f, engine),
      other = scope(f);
    const work = runtime.process({ revisionId: id });
    await entered;
    const closing = runtime.close();
    expect(aborted).toBe(true);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    await expect(runtime.process({ revisionId: id })).rejects.toThrow("停止准入");
    await other.process({ revisionId: id });
    release();
    await Promise.all([work, closing]);
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.close()).toBe(closing);
    expect(
      await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ renderStatus: "queued", renderAttemptNo: 1, fileId: null });
    expect(
      await (
        await db.prisma()
      ).outboxEvent.count({ where: { eventType: "license_letter.issued" } }),
    ).toBe(0);
  });
});
