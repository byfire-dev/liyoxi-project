import type { Data } from "@/lib/account-api";

export type Trailer = NonNullable<Data<"m.drama.get">["trailer"]>;
export type Playable = Data<"m.playable.get">;
export const trailerTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function trailerSource(trailer: Trailer, playable: Playable, now: number) {
  const source =
    playable.sources.find((item) => item.quality === "sd") ??
    playable.sources.find((item) => item.quality === "hd");
  if (playable.kind !== "trailer" || playable.playableId !== trailer.playableId || !source?.url)
    throw new Error("当前预告片不可播放，请刷新短剧详情");
  const expiresAt = playable.expiresAt ? Date.parse(playable.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 5000)
    throw new Error("播放地址已过期，请重新获取播放地址");
  return { source: source.url, expiresAt };
}

interface PlayerState {
  source: string | null;
  playing: boolean;
  muted: boolean;
  busy: boolean;
  error: string | null;
  mobilePrompt: boolean;
  positionMs: number;
  sourceAtMs: number;
  epoch: number;
  seekNo: number;
}

/** 每次点击只换取当前 playable；隐藏、身份变化和卸载使地址及在途结果失效。 */
export function createTrailerPlayer(deps: {
  trailer: Trailer;
  scope(): string;
  enabled(): boolean;
  now(): number;
  network(): Promise<string>;
  fetch(id: string): Promise<Playable>;
}) {
  const initialScope = deps.scope(),
    listeners = new Set<() => void>();
  let alive = true,
    hidden = false,
    blocked = false,
    generation = 0;
  let expiresAt = 0,
    mobileAccepted = false,
    automaticRetries = 0;
  let state: PlayerState = {
    source: null,
    playing: false,
    muted: true,
    busy: false,
    error: null,
    mobilePrompt: false,
    positionMs: 0,
    sourceAtMs: 0,
    epoch: 0,
    seekNo: 0,
  };
  const update = (patch: Partial<PlayerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const valid = () =>
    alive && !hidden && !blocked && deps.scope() === initialScope && deps.enabled();
  const sourceFresh = () => expiresAt > deps.now() + 5000;
  const stop = () => {
    generation++;
    expiresAt = 0;
    update({ source: null, playing: false, busy: false, mobilePrompt: false });
  };
  async function play(force = false) {
    if (!valid() || state.busy) return;
    const own = ++generation,
      current = () => valid() && generation === own;
    update({ busy: true, error: null });
    try {
      let network = "unknown";
      try {
        network = await deps.network();
      } catch {
        /* 未知网络也先确认流量。 */
      }
      if (!current()) return;
      if (network === "none") throw new Error("网络未连接，请联网后重试");
      if (network !== "wifi" && !mobileAccepted) {
        update({ source: null, playing: false, mobilePrompt: true });
        return;
      }
      if (!force && state.source && sourceFresh()) {
        update({ playing: true, mobilePrompt: false });
        return;
      }
      const playable = await deps.fetch(deps.trailer.playableId);
      if (!current()) return;
      const fresh = trailerSource(deps.trailer, playable, deps.now());
      expiresAt = fresh.expiresAt;
      update({
        source: fresh.source,
        playing: true,
        mobilePrompt: false,
        sourceAtMs: state.positionMs,
        epoch: state.epoch + 1,
      });
    } catch (error) {
      if (current())
        update({
          source: null,
          playing: false,
          error: error instanceof Error ? error.message : "预告片播放失败，请重试",
        });
    } finally {
      if (current()) update({ busy: false });
    }
  }
  const hasSource = (epoch: number) => valid() && epoch === state.epoch && Boolean(state.source);
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => {
      alive = true;
    },
    dispose: () => {
      alive = false;
      stop();
    },
    hide: () => {
      hidden = true;
      stop();
    },
    show: () => {
      hidden = false;
    },
    block: (value: boolean) => {
      blocked = value;
      if (value) stop();
    },
    play: () => {
      if (!state.busy) automaticRetries = 0;
      return play();
    },
    retry: () => {
      if (!state.busy) automaticRetries = 0;
      return play(true);
    },
    acceptMobile: () => {
      mobileAccepted = true;
      update({ mobilePrompt: false });
      return play(true);
    },
    dismissMobile: () => {
      if (!state.mobilePrompt) return;
      generation++;
      update({ mobilePrompt: false, busy: false });
    },
    pause: (epoch?: number) => {
      if (epoch !== undefined && (epoch !== state.epoch || state.busy)) return;
      if (valid()) update({ playing: false });
    },
    toggleMute: () => {
      if (valid()) update({ muted: !state.muted });
    },
    hasSource,
    canPlay: (epoch: number) => hasSource(epoch) && sourceFresh() && state.playing,
    time: (epoch: number, ms: number) => {
      if (!hasSource(epoch) || !Number.isFinite(ms)) return;
      if (!sourceFresh()) {
        stop();
        update({ error: "播放地址已过期，请重新获取播放地址" });
        return;
      }
      update({ positionMs: Math.max(0, Math.min(ms, deps.trailer.durationMs)) });
    },
    seek: (ms: number) => {
      if (!valid() || !state.source || !Number.isFinite(ms)) return;
      update({
        positionMs: Math.max(0, Math.min(ms, deps.trailer.durationMs)),
        seekNo: state.seekNo + 1,
      });
    },
    ended: (epoch: number) => {
      if (hasSource(epoch)) update({ playing: false, positionMs: 0, seekNo: state.seekNo + 1 });
    },
    failed: (epoch: number) => {
      if (!hasSource(epoch) || state.busy) return;
      stop();
      if (automaticRetries === 0) {
        automaticRetries++;
        void play(true);
      } else update({ error: "预告片播放失败，请重新获取播放地址" });
    },
  };
}
