import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { PortalApiError } from "../../lib/api-errors";
import { deferred, failure, ok, SESSION } from "../../lib/api.test-helpers";
import { createAdPreviewModel } from "./model";
import { AD, AD_ID, PLAYBACK } from "./test-helpers";

async function setup() {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(SESSION));
  const runtime = createPortalRuntime({ fetch: send });
  await runtime.session.load();
  const model = createAdPreviewModel(runtime, AD_ID);
  return {
    send,
    runtime,
    model,
    close: () => {
      model.dispose();
      runtime.dispose();
    },
  };
}
describe("W6-12 广告明确签发与当前授权/版本边界", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-04T00:00:00.000Z");
  });
  afterEach(() => vi.useRealTimers());

  it("GET不签发；一次显式播放带当前versionNo，双击同一在途请求，不加幂等键", async () => {
    const e = await setup();
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    expect(e.send).toHaveBeenCalledTimes(2);
    expect(e.model.getSnapshot().playback).toBeNull();
    const reply = deferred<Response>();
    e.send.mockReturnValueOnce(reply.promise);
    const playing = e.model.play();
    await e.model.play();
    expect(e.send).toHaveBeenCalledTimes(3);
    const [path, options] = e.send.mock.calls[2]!;
    expect(path).toBe(`/api/v1/portal/ads/${AD_ID}/playback-urls`);
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe(JSON.stringify({ versionNo: 1 }));
    expect(new Headers(options?.headers).get("X-LYX-Portal")).toBe("1");
    expect(new Headers(options?.headers).has("Idempotency-Key")).toBe(false);
    reply.resolve(ok(PLAYBACK));
    await playing;
    expect(e.model.getSnapshot().media).toBe("ready");
    expect(e.model.getSnapshot().playback?.kind).toBe("ad");
    e.close();
  });

  it("旧版409只刷新GET，新版本须另一次显式点击，不沿旧版自动补POST", async () => {
    const e = await setup();
    const next = {
      ...AD,
      currentVersionNo: 2,
      currentVersion: { ...AD.currentVersion, versionNo: 2 },
    };
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    e.send
      .mockResolvedValueOnce(failure("AD_VERSION_STALE", 409, { details: { currentVersionNo: 2 } }))
      .mockResolvedValueOnce(ok(next));
    await e.model.play();
    expect(e.model.getSnapshot()).toMatchObject({
      notice: "version_changed",
      playback: null,
      media: "idle",
    });
    expect(e.model.getSnapshot().detail?.currentVersionNo).toBe(2);
    expect(e.send.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.send).toHaveBeenCalledTimes(4);
    e.send.mockResolvedValueOnce(ok(PLAYBACK));
    await e.model.play();
    expect(e.send.mock.calls[4]?.[1]?.body).toBe(JSON.stringify({ versionNo: 2 }));
    e.close();
  });

  it("到期清播放源；媒体失败也清源，两个边界都不自动重新签发", async () => {
    const e = await setup();
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    e.send.mockResolvedValueOnce(ok({ ...PLAYBACK, expiresAt: "2026-11-04T00:00:01.000Z" }));
    await e.model.play();
    await vi.advanceTimersByTimeAsync(1001);
    expect(e.model.getSnapshot()).toMatchObject({ media: "expired", playback: null });
    expect(e.send).toHaveBeenCalledTimes(3);
    e.send.mockResolvedValueOnce(ok(PLAYBACK));
    await e.model.play();
    e.model.mediaFailed();
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.model.getSnapshot()).toMatchObject({ media: "failed", playback: null });
    expect(e.send).toHaveBeenCalledTimes(4);
    e.close();
  });

  it("401/换scope与卸载废弃迟到签发，不能恢复播放器或旧详情", async () => {
    for (const mode of ["invalidate", "dispose"] as const) {
      const e = await setup();
      e.send.mockResolvedValueOnce(ok(AD));
      await e.model.load();
      const reply = deferred<Response>();
      e.send.mockReturnValueOnce(reply.promise);
      const pending = e.model.play();
      if (mode === "invalidate")
        e.runtime.session.invalidate(new PortalApiError("PORTAL_SESSION_INVALID", 401));
      else e.model.dispose();
      expect(e.send.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      reply.resolve(ok(PLAYBACK));
      await pending;
      expect(e.model.getSnapshot().playback).toBeNull();
      expect(e.model.getSnapshot().detail).toBeNull();
      e.close();
    }
    const e = await setup();
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    e.send.mockResolvedValueOnce(
      failure("PORTAL_SESSION_INVALID", 401, { details: { reason: "revoked" } }),
    );
    await e.model.play();
    expect(e.model.getSnapshot().status).toBe("invalid");
    expect(e.runtime.session.getSnapshot().status).toBe("invalid");
    e.close();
  });

  it("显式刷新中断旧签发；未开放广告不POST，未知输入不请求", async () => {
    const e = await setup();
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    const late = deferred<Response>();
    e.send.mockReturnValueOnce(late.promise);
    const pending = e.model.play();
    e.send.mockResolvedValueOnce(ok({ ...AD, isPortalPreviewable: false }));
    await e.model.load();
    late.resolve(ok(PLAYBACK));
    await pending;
    await e.model.play();
    expect(e.model.getSnapshot().playback).toBeNull();
    expect(e.send).toHaveBeenCalledTimes(4);
    const invalid = createAdPreviewModel(e.runtime, "bad-id");
    await invalid.load();
    await invalid.play();
    expect(e.send).toHaveBeenCalledTimes(4);
    invalid.dispose();
    e.close();
  });

  it("429按服务端冷却，网络未知结果/媒体kind错误不自动重试且不保原错误", async () => {
    const e = await setup();
    e.send.mockResolvedValueOnce(ok(AD));
    await e.model.load();
    e.send.mockResolvedValueOnce(failure("RATE_LIMITED", 429, {}, { "Retry-After": "5" }));
    await e.model.play();
    await e.model.play();
    expect(e.send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.send).toHaveBeenCalledTimes(3);
    e.send.mockRejectedValueOnce(new Error("private signed URL must not survive"));
    await e.model.play();
    expect(e.model.getSnapshot().error?.error).toBe("NETWORK_ERROR");
    expect(e.model.getSnapshot().error?.message).not.toContain("private signed");
    e.send.mockResolvedValueOnce(ok({ ...PLAYBACK, kind: "sample" }));
    await e.model.play();
    expect(e.model.getSnapshot().error?.error).toBe("INVALID_RESPONSE");
    expect(e.model.getSnapshot().playback).toBeNull();
    e.close();
  });
});
