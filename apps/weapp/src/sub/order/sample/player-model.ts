import type { Sample } from "../components/delivery-api";
import { sampleIdentity, samplePlaybackBlocker } from "./model";

interface PlayerState {
  source: string | null;
  playing: boolean;
  busy: boolean;
  mobilePrompt: boolean;
  error: string | null;
  positionMs: number;
  sourceAtMs: number;
  epoch: number;
  seekNo: number;
}
interface PlayerDeps {
  sample: NonNullable<Sample>;
  scope(): string;
  enabled(): boolean;
  now(): number;
  network(): Promise<string>;
  reload(): Promise<Sample>;
  replace(view: Sample, current: () => boolean): void;
}

/** 本页的短时地址仅存内存；重读一旦换版，交回页面替换，绝不续播旧版。 */
export function createSamplePlayer(deps: PlayerDeps) {
  const scope = deps.scope(),
    identity = sampleIdentity(deps.sample);
  let sample = deps.sample,
    live = true,
    hidden = false,
    blocked = false,
    generation = 0,
    approvedMobile = false,
    retried = false,
    pendingRefresh = false;
  let state: PlayerState = {
    source: null,
    playing: false,
    busy: false,
    mobilePrompt: false,
    error: null,
    positionMs: 0,
    sourceAtMs: 0,
    epoch: 0,
    seekNo: 0,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<PlayerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const valid = () => live && !hidden && !blocked && deps.scope() === scope && deps.enabled();
  const capture = () => {
    const at = generation;
    return () => valid() && at === generation;
  };
  const stop = () => {
    generation++;
    update({ source: null, playing: false, busy: false, mobilePrompt: false });
  };
  const expired = () => {
    const expiry = sample.playable?.expiresAt;
    return (
      !expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= deps.now() + 5000
    );
  };
  async function start(force: boolean, current: () => boolean) {
    if (force || expired()) {
      const fresh = await deps.reload();
      if (!current()) return;
      if (!fresh || sampleIdentity(fresh) !== identity) {
        deps.replace(fresh, current);
        stop();
        return;
      }
      sample = fresh;
      deps.replace(fresh, current);
    }
    if (!current()) return;
    const blocker = samplePlaybackBlocker(sample, deps.enabled());
    if (blocker) throw new Error(blocker);
    if (expired()) throw new Error("播放地址已过期，请重新获取播放地址");
    const source = sample.playable!.sources[0]!.url;
    update({
      source,
      playing: true,
      mobilePrompt: false,
      error: null,
      sourceAtMs: state.source === source ? state.sourceAtMs : state.positionMs,
      epoch: state.source === source ? state.epoch : state.epoch + 1,
    });
  }
  async function play(force = false) {
    if (!valid() || state.busy) return;
    const blocker = samplePlaybackBlocker(sample, deps.enabled());
    if (blocker) {
      update({ error: blocker });
      return;
    }
    const current = capture();
    update({ busy: true, error: null });
    try {
      let network = "unknown";
      try {
        network = await deps.network();
      } catch {
        /* 未知网络也先提示流量。 */
      }
      if (!current()) return;
      if (network === "none") throw new Error("网络未连接，请联网后重试");
      if (network !== "wifi" && !approvedMobile) {
        pendingRefresh = force;
        update({ mobilePrompt: true, source: null, playing: false });
        return;
      }
      await start(force, current);
    } catch (error) {
      if (current())
        update({
          source: null,
          playing: false,
          error: error instanceof Error ? error.message : "播放失败，请重试",
        });
    } finally {
      if (current()) update({ busy: false });
    }
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => {
      live = true;
    },
    dispose: () => {
      live = false;
      stop();
    },
    hide: () => {
      hidden = true;
      stop();
    },
    show: () => {
      hidden = false;
    },
    sync: (fresh: NonNullable<Sample>) => {
      const changed =
        fresh.playable?.sources[0]?.url !== sample.playable?.sources[0]?.url ||
        fresh.playable?.expiresAt !== sample.playable?.expiresAt;
      sample = fresh;
      if (
        sampleIdentity(fresh) !== identity ||
        samplePlaybackBlocker(fresh, deps.enabled()) ||
        changed
      )
        stop();
    },
    block: (value: boolean) => {
      blocked = value;
      if (value) stop();
    },
    play: () => {
      if (!state.busy) retried = false;
      return play();
    },
    retry: () => {
      if (!state.busy) retried = false;
      return play(true);
    },
    acceptMobile: () => {
      approvedMobile = true;
      update({ mobilePrompt: false });
      return play(pendingRefresh);
    },
    dismissMobile: () => {
      // Popup在visible变false后也回调onClose；已接受时不能取消刚开始的播放。
      if (!state.mobilePrompt) return;
      generation++;
      update({ mobilePrompt: false, busy: false });
    },
    pause: () => {
      if (valid()) update({ playing: false });
    },
    canPlay: (epoch: number) => valid() && state.epoch === epoch && state.playing,
    hasSource: (epoch: number) => valid() && state.epoch === epoch && Boolean(state.source),
    time: (epoch: number, ms: number) => {
      if (valid() && state.source && epoch === state.epoch && Number.isFinite(ms))
        update({ positionMs: Math.max(0, Math.min(ms, sample.durationMs)) });
    },
    ended: (epoch: number) => {
      if (valid() && epoch === state.epoch) update({ playing: false, positionMs: 0 });
    },
    seek: (ms: number) => {
      if (!valid() || !Number.isFinite(ms)) return;
      update({
        positionMs: Math.max(0, Math.min(ms, sample.durationMs)),
        seekNo: state.seekNo + 1,
      });
      if (!state.source) void play();
    },
    failed: (epoch: number) => {
      if (!valid() || state.busy || epoch !== state.epoch || !state.source) return;
      update({ source: null, playing: false });
      if (!retried) {
        retried = true;
        void play(true);
      } else update({ error: "样片播放失败，请重新获取播放地址" });
    },
  };
}
