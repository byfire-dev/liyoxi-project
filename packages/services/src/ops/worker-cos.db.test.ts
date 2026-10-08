import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as kernel from "../kernel/index.js";
import type { Env } from "../kernel/index.js";
import { assembleForTest, createClock, useTestDatabase } from "../testing/index.js";
import { buildWorkerServices } from "./index.js";

const db = useTestDatabase("services");
const clock = createClock();
const cos: NonNullable<Env["COS"]> = {
  region: "ap-beijing",
  buckets: {
    secure: "worker-secure-1250000000",
    asset: "worker-asset-1250000000",
    media: "worker-media-1250000000",
    pub: "worker-pub-1250000000",
  },
  signer: { secretId: "fake-api-signer", secretKey: "fake-api-signer-key" },
  stsIssuer: { secretId: "fake-api-issuer", secretKey: "fake-api-issuer-key" },
  worker: { secretId: "fake-worker", secretKey: "fake-worker-key" },
};
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const owned: ReturnType<typeof buildWorkerServices>[] = [];
const channel = {
  enqueue: vi.fn(async () => {
    throw new Error("不入队");
  }),
  downForMs: () => 0,
};
const build = (config = cos) => {
  const options = {
    appEnv: "test" as const,
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    channel,
    keys: { COS: config },
  };
  const services = buildWorkerServices(options);
  owned.push(services);
  return services;
};
beforeAll(async () => {
  prisma = await db.prisma();
});
afterEach(async () => {
  for (const services of owned.splice(0)) {
    services.closeWebhooks?.();
    services.closeAnalytics?.();
    services.closeOrder?.();
    services.closeBillingTimers?.();
    services.closePublish?.();
    services.closeDelivery?.();
    await services.closeStorageDrivers?.();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("真实worker组合根的COS角色与自有关闭", () => {
  it("buildWorkerServices构造零外呼并选择COS，保持注入clock", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const spy = vi.spyOn(kernel, "assembleProviders");
    const services = build();
    expect(services.providers.storage.status).toBe("cos");
    expect(fetch).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].storage?.now()).toEqual(clock.now());
  });
  it("factory只得到worker角色；不借API signer/issuer或授STS", () => {
    const spy = vi.spyOn(kernel, "assembleProviders");
    const services = build();
    expect(spy.mock.calls[0]![0].settings?.storage).toEqual({
      driver: "cos",
      cos: {
        region: cos.region,
        buckets: cos.buckets,
        worker: cos.worker,
      },
    });
    expect(services.providers.storage.capabilities.sts).toBe(false);
  });
  it("只有API角色的env在绑定/工厂前拒绝，不回退MinIO或借角色", () => {
    const spy = vi.spyOn(kernel, "assembleProviders");
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const apiOnly = {
      region: cos.region,
      buckets: cos.buckets,
      signer: cos.signer,
      stsIssuer: cos.stsIssuer,
    };
    expect(() => build(apiOnly)).toThrow(/COS.*worker/);
    expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("自有close取消在途COS并等待清理；可重入，借用数据库/队列不关", async () => {
    let accepted!: () => void;
    const entered = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    let listeners = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const signal = init!.signal!;
      let abort!: () => void;
      try {
        return await new Promise<Response>((_resolve, reject) => {
          abort = () => reject(new Error("fake owned aborted"));
          listeners++;
          signal.addEventListener("abort", abort, { once: true });
          accepted();
        });
      } finally {
        signal.removeEventListener("abort", abort);
        listeners--;
      }
    };
    vi.stubGlobal("fetch", fetch);
    const services = build();
    expect(services.providers.storage.status).toBe("cos");
    expect(typeof services.closeStorageDrivers).toBe("function");
    const pending = services.providers.storage.head({ bucket: "asset", key: "formal/a.png" });
    await entered;
    await Promise.all([services.closeStorageDrivers!(), services.closeStorageDrivers!()]);
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(listeners).toBe(0);
    expect(await prisma.$queryRaw`SELECT 1 AS alive`).toEqual([{ alive: 1 }]);
    expect(channel.enqueue).not.toHaveBeenCalled();
    expect(
      await services.providers.storage.head({ bucket: "asset", key: "formal/a.png" }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
