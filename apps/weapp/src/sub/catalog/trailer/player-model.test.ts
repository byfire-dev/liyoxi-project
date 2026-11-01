import { describe, expect, it, vi } from "vitest";
import { createTrailerPlayer, trailerSource, type Playable, type Trailer } from "./player-model";

const trailer: Trailer = { playableId: "trailer-1", posterUrl: null, durationMs: 90_000 };
const playable = (): Playable => ({
  playableId: trailer.playableId,
  kind: "trailer",
  durationMs: 90_000,
  width: 180,
  height: 320,
  posterUrl: null,
  sources: [
    { quality: "sd", url: "/local-trailer.mp4", width: 180, height: 320, bitrateKbps: null },
  ],
  expiresAt: "2026-11-02T01:00:00Z",
  autoplay: true,
  muted: true,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function setup() {
  let scope = "owner:store:1",
    enabled = true,
    now = Date.parse("2026-11-02T00:00:00Z");
  const fetch = vi.fn(async (_id: string) => playable()),
    network = vi.fn(async () => "wifi");
  const player = createTrailerPlayer({
    trailer,
    scope: () => scope,
    enabled: () => enabled,
    now: () => now,
    fetch,
    network,
  });
  return {
    player,
    fetch,
    network,
    switchScope: () => {
      scope = "clerk:store:2";
    },
    disable: () => {
      enabled = false;
    },
    expire: () => {
      now = Date.parse("2026-11-02T02:00:00Z");
    },
  };
}
describe("预告片点击播放、短时地址与生命周期", () => {
  it("未点击不取地址且默认静音；移动网络确认前不取地址，取消后可再次确认", async () => {
    const { player, fetch, network } = setup();
    expect(player.snapshot()).toMatchObject({ source: null, playing: false, muted: true });
    expect(fetch).not.toHaveBeenCalled();
    network.mockResolvedValue("4g");
    await player.play();
    expect(player.snapshot().mobilePrompt).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    player.dismissMobile();
    await player.play();
    await player.acceptMobile();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(trailer.playableId);
    expect(player.snapshot()).toMatchObject({
      source: "/local-trailer.mp4",
      playing: true,
      muted: true,
    });
    player.toggleMute();
    expect(player.snapshot().muted).toBe(false);
  });
  it.each(["hide", "dispose", "scope", "flag"])(
    "%s取消在途地址，不允许迟到成功恢复播放",
    async (reason) => {
      const { player, fetch, switchScope, disable } = setup(),
        pending = deferred<Playable>();
      fetch.mockReturnValueOnce(pending.promise);
      const run = player.play();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      if (reason === "hide") player.hide();
      else if (reason === "dispose") player.dispose();
      else if (reason === "scope") switchScope();
      else disable();
      pending.resolve(playable());
      await run;
      expect(player.snapshot().source).toBeNull();
      expect(player.canPlay(player.snapshot().epoch)).toBe(false);
    },
  );
  it("隐藏立即丢弃地址，返回不自动续播；再次点击才换取地址", async () => {
    const { player, fetch } = setup();
    await player.play();
    player.hide();
    player.show();
    expect(player.snapshot()).toMatchObject({ source: null, playing: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    await player.play();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("拒绝错误kind/id、空source与过期地址，播放中到期也清除URL", async () => {
    const current = playable();
    for (const invalid of [
      { ...current, kind: "ad" as const },
      { ...current, playableId: "another" },
      { ...current, sources: [] },
      { ...current, expiresAt: null },
    ])
      expect(() => trailerSource(trailer, invalid, Date.parse("2026-11-02T00:00:00Z"))).toThrow();
    const { player, fetch, expire } = setup();
    fetch.mockResolvedValueOnce({ ...current, expiresAt: "2026-11-01T00:00:00Z" });
    await player.play();
    expect(player.snapshot().error).toContain("已过期");
    expect(fetch).toHaveBeenCalledTimes(1);
    await player.retry();
    expire();
    player.time(player.snapshot().epoch, 1500);
    expect(player.snapshot()).toMatchObject({ source: null, playing: false });
  });
  it("媒体错误仅自动重取一次，第二次保留手动重试，避免错误循环", async () => {
    const { player, fetch } = setup();
    await player.play();
    const oldEpoch = player.snapshot().epoch;
    player.failed(player.snapshot().epoch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(player.snapshot().busy).toBe(false));
    player.pause(oldEpoch);
    expect(player.snapshot().playing).toBe(true);
    player.failed(player.snapshot().epoch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(player.snapshot().error).toContain("重新获取");
    await player.retry();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
