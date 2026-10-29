import { describe, expect, it, vi } from "vitest";
import { sample } from "../../../../shots/delivery-fixtures";
import type { Sample } from "../components/delivery-api";
import { createSamplePlayer } from "./player-model";
import { sampleConfirmation, samplePlaybackBlocker } from "./model";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function setup(view = structuredClone(sample)) {
  let scope = "store:owner:1",
    enabled = true;
  const fresh = structuredClone(sample);
  fresh.playable!.sources[0]!.url = "/fresh-sample.mp4";
  const reload = vi.fn(async (): Promise<Sample> => fresh);
  const replace = vi.fn((_view: Sample, _current: () => boolean) => {});
  const network = vi.fn(async () => "wifi");
  const player = createSamplePlayer({
    sample: view,
    scope: () => scope,
    enabled: () => enabled,
    now: () => Date.parse("2026-10-29T00:00:00Z"),
    network,
    reload,
    replace,
  });
  return {
    player,
    reload,
    replace,
    network,
    fresh,
    switchScope: () => {
      scope = "store:owner:2";
    },
    disable: () => {
      enabled = false;
    },
  };
}

describe("小程序样片播放与自主勾选", () => {
  it("未点击不播放、不请求；移动网络确认前不加载视频，取消可重试", async () => {
    const { player, network, reload } = setup();
    expect(player.snapshot().source).toBeNull();
    expect(network).not.toHaveBeenCalled();
    network.mockResolvedValue("4g");
    await player.play();
    expect(player.snapshot()).toMatchObject({ mobilePrompt: true, source: null, busy: false });
    expect(reload).not.toHaveBeenCalled();
    player.dismissMobile();
    expect(player.snapshot().mobilePrompt).toBe(false);
    await player.play();
    const accepted = player.acceptMobile();
    player.dismissMobile();
    await accepted;
    expect(player.snapshot()).toMatchObject({
      mobilePrompt: false,
      source: "/sample-preview.mp4",
      playing: true,
    });
  });
  it("自主勾选即可确认weapp，不强制播放结束；旧渠道与不可用版本拒绝", () => {
    expect(sampleConfirmation(sample, true)).toEqual({
      versionNo: 2,
      viewedVia: "weapp",
      hasViewed: true,
    });
    expect(() => sampleConfirmation(sample, false)).toThrow("我已查看");
    for (const view of [
      { ...sample, previewChannels: ["album", "portal"] as ("album" | "portal")[] },
      { ...sample, playable: null },
      { ...sample, status: "superseded" as const },
      { ...sample, confirmableVia: ["album"] as "album"[] },
    ])
      expect(() => sampleConfirmation(view, true)).toThrow();
    expect(samplePlaybackBlocker(sample, false)).toContain("联系服务经理");
  });
  it("过期只重读当前样片，同版fresh回写并sync保留续播进度", async () => {
    const view = structuredClone(sample);
    view.playable!.expiresAt = "2026-10-28T00:00:00Z";
    const { player, reload, replace } = setup(view);
    replace.mockImplementation((fresh) => {
      if (fresh) player.sync(fresh);
    });
    player.seek(15000);
    await vi.waitFor(() => expect(player.snapshot().busy).toBe(false));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(player.snapshot()).toMatchObject({
      source: "/fresh-sample.mp4",
      positionMs: 15000,
      playing: true,
    });
    const epoch = player.snapshot().epoch;
    player.pause();
    await player.play();
    expect(player.snapshot()).toMatchObject({ epoch, positionMs: 15000, playing: true });
  });
  it("一次播放报错自动重GET，再次报错保留手动重试，retry穿过移动确认仍强制刷新", async () => {
    const { player, reload, network } = setup();
    await player.play();
    player.time(player.snapshot().epoch, 23000);
    player.failed(player.snapshot().epoch);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(player.snapshot().busy).toBe(false));
    expect(player.snapshot()).toMatchObject({ source: "/fresh-sample.mp4", positionMs: 23000 });
    player.failed(player.snapshot().epoch);
    expect(player.snapshot().error).toContain("重新获取");
    expect(reload).toHaveBeenCalledTimes(1);
    network.mockResolvedValue("4g");
    await player.retry();
    expect(player.snapshot().mobilePrompt).toBe(true);
    await player.acceptMobile();
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("外部同版本换签或撤销可播状态时停止旧source，保留已播进度", async () => {
    const { player, fresh } = setup();
    await player.play();
    const epoch = player.snapshot().epoch;
    player.time(epoch, 9000);
    player.sync(fresh);
    expect(player.snapshot()).toMatchObject({ source: null, playing: false, positionMs: 9000 });
    expect(player.canPlay(epoch)).toBe(false);
    await player.play();
    expect(player.snapshot().source).toBe("/fresh-sample.mp4");
    player.sync({ ...fresh, playable: null });
    expect(player.snapshot().source).toBeNull();
    await player.play();
    expect(player.snapshot().error).toContain("联系服务经理");
  });
  it.each(["hide", "scope", "dispose", "block", "flag"])(
    "%s废弃在途重GET的迟到结果与错误",
    async (reason) => {
      const { player, reload, replace, switchScope, disable, fresh } = setup();
      const pending = deferred<Sample>();
      reload.mockReturnValue(pending.promise);
      const run = player.retry();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      if (reason === "hide") player.hide();
      if (reason === "scope") switchScope();
      if (reason === "dispose") player.dispose();
      if (reason === "block") player.block(true);
      if (reason === "flag") disable();
      pending.resolve(fresh);
      await run;
      expect(replace).not.toHaveBeenCalled();
      expect(player.snapshot().source).toBeNull();
      expect(player.snapshot().error).toBeNull();
    },
  );
  it("页面隐藏后不自动续播；迟到播放事件和换版响应不复活旧URL", async () => {
    const { player, reload, replace, fresh } = setup();
    await player.play();
    const epoch = player.snapshot().epoch;
    player.hide();
    player.show();
    expect(player.canPlay(epoch)).toBe(false);
    expect(player.snapshot().source).toBeNull();
    const newer = { ...fresh, sampleId: "new-sample", versionNo: 3 };
    reload.mockResolvedValue(newer);
    await player.retry();
    expect(replace).toHaveBeenCalledWith(newer, expect.any(Function));
    expect(player.snapshot()).toMatchObject({ source: null, playing: false });
  });
  it("父资源先换版时，旧版在途换签响应被丢弃", async () => {
    const { player, reload, replace, fresh } = setup();
    const pending = deferred<Sample>();
    reload.mockReturnValue(pending.promise);
    const run = player.retry();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    player.sync({ ...fresh, versionNo: 3 });
    pending.resolve(fresh);
    await run;
    expect(replace).not.toHaveBeenCalled();
    expect(player.snapshot()).toMatchObject({ source: null, playing: false });
  });
  it("网络/换签失败可见且互斥；网络失败不写查看证据", async () => {
    const { player, reload, network, replace } = setup();
    network.mockResolvedValue("none");
    await player.play();
    expect(player.snapshot().error).toContain("网络未连接");
    expect(reload).not.toHaveBeenCalled();
    network.mockResolvedValue("wifi");
    const pending = deferred<Sample>();
    reload.mockReturnValue(pending.promise);
    const first = player.retry();
    await player.retry();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    player.hide();
    pending.reject(new Error("迟到网络错误"));
    await first;
    expect(player.snapshot().error).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
