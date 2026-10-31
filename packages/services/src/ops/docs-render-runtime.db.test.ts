import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocsRenderRuntime } from "./docs-render-runtime.js";
import type { LicenseRenderingEngine } from "./docs-render-runtime.js";
import {
  createLicenseConvergenceFixture,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { reconcileLetters, sweepLicenseRevisions, voidLicenseLetter } from "../docs/index.js";
import { alertsOf, createIdentityContext, isInTransaction } from "../kernel/index.js";
import type { AlertInput, Alerts } from "../kernel/index.js";

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
function scope(
  f: Fixture,
  engine?: LicenseRenderingEngine,
  alerts: Alerts = alertsOf(f.runtime.assembly),
) {
  const runtime = createDocsRenderRuntime({
    tx: f.runtime.tx,
    clock: f.clock,
    convergence: f.licenseDeps,
    media: f.runtime.media,
    channel: { enqueue: async () => {} },
    alerts,
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

const FAILURE_RULE = "docs.license_render_failed";
function failingEngine(path: "render" | "sign" | "exception"): LicenseRenderingEngine {
  return {
    renderer: {
      configured: true,
      close: async () => {},
      render: async () => {
        if (path === "exception") throw new Error("受控渲染失败");
        return path === "render"
          ? { ok: false, reason: "unavailable" }
          : { ok: true, value: { pdf: Buffer.from("%PDF-1.7\n%%EOF") } };
      },
    },
    signer: {
      configured: true,
      status: "fake",
      seal: async () => ({
        ok: false,
        reason: "unavailable",
        message: "受控签署失败",
      }),
    },
    close: async () => {},
  };
}
async function failureAlerts(f: Fixture, revisionId: string) {
  const prisma = await db.prisma(),
    real = alertsOf(f.runtime.assembly);
  const alerts: Alerts = {
    raise: vi.fn(async (input: AlertInput) => {
      expect(isInTransaction()).toBe(false);
      // This independent read must observe the committed terminal transition before the alert starts.
      expect(
        await prisma.licenseLetterRevision.findUniqueOrThrow({ where: { id: revisionId } }),
      ).toMatchObject({ renderStatus: "failed", renderAttemptNo: 4 });
      await real.raise(input);
    }),
  };
  const rows = () =>
    prisma.alertEvent.findMany({ where: { fingerprint: `${FAILURE_RULE}:${revisionId}` } });
  return { alerts, rows };
}

describe("授权书正常渲染失败耗尽告警", () => {
  it.each(["render", "sign", "exception"] as const)(
    "%s分支仅第四次正常失败提交后写真实P2告警，重复投递不重复报",
    async (path) => {
      const { f, id } = await fresh(),
        observed = await failureAlerts(f, id);
      const runtime = scope(f, failingEngine(path), observed.alerts);
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (path === "exception")
          await expect(runtime.process({ revisionId: id })).rejects.toThrow("受控渲染失败");
        else await runtime.process({ revisionId: id });
        expect(
          await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          renderAttemptNo: attempt,
          renderStatus: attempt === 4 ? "failed" : "queued",
        });
        if (attempt < 4) {
          expect(observed.alerts.raise).not.toHaveBeenCalled();
          expect(await observed.rows()).toEqual([]);
        }
      }
      expect(observed.alerts.raise).toHaveBeenCalledOnce();
      expect(await observed.rows()).toMatchObject([
        {
          rule: FAILURE_RULE,
          fingerprint: `${FAILURE_RULE}:${id}`,
          severity: "P2",
          kind: "event",
          status: "open",
          occurrences: 1,
          lastValue: { revisionId: id, reason: "attempts_exhausted" },
        },
      ]);
      await runtime.process({ revisionId: id });
      expect(observed.alerts.raise).toHaveBeenCalledOnce();
      expect(await observed.rows()).toHaveLength(1);
      expect((await observed.rows())[0]!.occurrences).toBe(1);
    },
  );

  it.each(["stale", "voided", "shutdown"] as const)(
    "第四次任务变为%s时不误发耗尽告警",
    async (condition) => {
      const { f, id } = await fresh(),
        observed = await failureAlerts(f, id);
      let enter!: () => void,
        release!: () => void,
        calls = 0;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const engine = failingEngine("render");
      const runtime = scope(
        f,
        {
          ...engine,
          renderer: {
            ...engine.renderer,
            render: async () => {
              calls++;
              if (calls === 4) {
                enter();
                await held;
              }
              return { ok: false, reason: "unavailable" };
            },
          },
        },
        observed.alerts,
      );
      for (let i = 0; i < 3; i++) await runtime.process({ revisionId: id });
      const work = runtime.process({ revisionId: id });
      await entered;
      let closing: Promise<void> | undefined;
      if (condition === "stale") {
        const claimed = await (
          await db.prisma()
        ).licenseLetterRevision.findUniqueOrThrow({ where: { id } });
        f.clock.set(new Date(claimed.renderLeaseUntil!.getTime() + 1));
        // Sweep owns its alert separately; the late normal-failure callback must not report it again.
        expect(
          (await f.runtime.tx.run((tx) => sweepLicenseRevisions(tx, runtime.queue))).failed,
        ).toContain(id);
      } else if (condition === "voided") {
        const revision = await (
          await db.prisma()
        ).licenseLetterRevision.findUniqueOrThrow({ where: { id } });
        await f.runtime.tx.run((tx) =>
          voidLicenseLetter(
            tx,
            f.licenseDeps,
            createIdentityContext({ actor: { type: "system", job: "lyxtest.render_retired" } }),
            { licenseLetterId: revision.licenseLetterId, note: "当前法律授权已作废" },
          ),
        );
      } else closing = runtime.close();
      release();
      await work;
      await closing;
      expect(observed.alerts.raise).not.toHaveBeenCalled();
      expect(await observed.rows()).toEqual([]);
    },
  );
});
