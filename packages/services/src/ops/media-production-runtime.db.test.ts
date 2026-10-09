import { describe, expect, it, vi } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { Env } from "../kernel/index.js";
import type { ProductionMediaTools } from "../providers/index.js";
import { failed } from "../providers/types.js";
import { createFakeProviders, useTestDatabase } from "../testing/index.js";
import { createRuntimeMediaProduction } from "./media-production-runtime.js";

const db = useTestDatabase("services", { label: "mediatools" });
const config: NonNullable<Env["MEDIA_PRODUCTION"]> = {
  workDir: "/tmp/lyx-tool-test",
  socketPath: "/tmp/lyx-tool-test/.sock/media.sock",
  aigc: {
    Label: "1",
    ContentProducer: "虚构测试主体",
    ReservedCode1: "",
    ContentPropagator: "",
    ReservedCode2: "",
  },
  templates: {
    normalize: "test-normalize",
    sd: "test-sd",
    hd: "test-hd",
    sample: "test-sample",
    brand: "test-brand",
    ai: "test-ai",
  },
};
function rawTools() {
  const sent = vi.fn(),
    close = vi.fn(async () => {});
  const call = async () => {
    sent();
    return failed("unavailable", "明确的测试替身");
  };
  const raw: ProductionMediaTools = {
    client: { probe: call, poster: call, stampAigc: call, health: call, watermarkPng: call },
    workspace: {
      run: (_job, _signal, action) =>
        action({ path: (name) => `owned/${name}`, download: call, publish: call }),
      close,
    },
    close,
  };
  return { raw, sent, close };
}
describe("W3-04 测试工具装配保留真实边界", { timeout: 60_000 }, () => {
  it("stg/prod或缺完整配置在任何工具调用前拒绝注入", () => {
    const raw = rawTools(),
      providers = createFakeProviders();
    for (const appEnv of ["stg", "prod"] as const)
      expect(() =>
        createRuntimeMediaProduction(config, providers, { appEnv, tools: raw.raw }),
      ).toThrow(TypeError);
    expect(() =>
      createRuntimeMediaProduction(undefined, providers, { appEnv: "test", tools: raw.raw }),
    ).toThrow(TypeError);
    expect(raw.sent).not.toHaveBeenCalled();
    expect(raw.close).not.toHaveBeenCalled();
  });
  it("真事务内连无效输入/preabort都先守卫，workspace内单次IO也先守卫", async () => {
    const tx = createTxRunner({ prisma: await db.prisma(), appEnv: "test" });
    const raw = rawTools(),
      scope = createRuntimeMediaProduction(config, createFakeProviders(), {
        appEnv: "test",
        tools: raw.raw,
      });
    const signal = AbortSignal.abort();
    try {
      await expect(
        tx.run(() => scope.production!.tool.probe({ path: "../invalid", demuxers: [], signal })),
      ).rejects.toMatchObject({ kind: "external_call_in_transaction" });
      await expect(
        tx.run(() =>
          scope.production!.workspace.run({ id: uuidv7(), attemptNo: 1 }, signal, async () => null),
        ),
      ).rejects.toMatchObject({ kind: "external_call_in_transaction" });
      await scope.production!.workspace.run(
        { id: uuidv7(), attemptNo: 1 },
        new AbortController().signal,
        async (work) => {
          await expect(
            tx.run(() =>
              work.download({ bucket: "media", key: "owned/source.mp4", size: 1, etag: "test" }),
            ),
          ).rejects.toMatchObject({ kind: "external_call_in_transaction" });
        },
      );
      expect(raw.sent).not.toHaveBeenCalled();
    } finally {
      await scope.close();
    }
  });
  it("两个scope各关自己的工具一次，borrowed storage继续可用", async () => {
    const providers = createFakeProviders(),
      first = rawTools(),
      second = rawTools();
    const a = createRuntimeMediaProduction(config, providers, { appEnv: "test", tools: first.raw });
    const b = createRuntimeMediaProduction(config, providers, {
      appEnv: "test",
      tools: second.raw,
    });
    await Promise.all([a.close(), a.close()]);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect((await b.production!.tool.health()).ok).toBe(false);
    expect((await providers.storage.head({ bucket: "media", key: "owned/source.mp4" })).ok).toBe(
      true,
    );
    await b.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });
  it("关闭先取消在途调用并真正等其finally，关闭后不再发出IO", async () => {
    const raw = rawTools(),
      final = vi.fn();
    raw.raw.client.health = async (signal) => {
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return failed("unavailable", "已取消");
      } finally {
        final();
      }
    };
    const scope = createRuntimeMediaProduction(config, createFakeProviders(), {
      appEnv: "test",
      tools: raw.raw,
    });
    const pending = scope.production!.tool.health();
    await scope.close();
    await pending;
    expect(final).toHaveBeenCalledTimes(1);
    await expect(scope.production!.tool.health()).rejects.toThrow("已关闭");
    expect(raw.close).toHaveBeenCalledTimes(1);
  });
});
