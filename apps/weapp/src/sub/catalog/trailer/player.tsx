import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Image, Slider, Video, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { sharedTokens } from "@liyoxi/shared/design/tokens";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import { TextButton } from "@/components/TextButton";
import { uuid } from "@/lib/platform";
import { useBootstrapStore, flagOn } from "@/stores/bootstrap";
import { trailerApi } from "./api";
import { createTrailerPlayer, trailerTime, type Trailer } from "./player-model";
import {
  exitTrailerFullscreen,
  requestTrailerFullscreen,
  watchTrailerFullscreen,
} from "./player-platform";
import { trailerScopeKey } from "./scope";
import { DetailTrailerControls } from "./detail-controls";
import "./player.scss";

export function TrailerPlayer({
  trailer,
  title,
  feed = false,
  compact = false,
  blocked = false,
  onLandscapeChange,
  children,
}: {
  trailer: Trailer;
  title: string;
  feed?: boolean;
  compact?: boolean;
  blocked?: boolean;
  onLandscapeChange?(landscape: boolean): void;
  children?: ReactNode;
}) {
  const enabled = useBootstrapStore(
    (state) =>
      state.data.flags["weapp.video.trailer.enabled"] === true &&
      (!feed || state.data.flags["weapp.trailer.feed"] === true),
  );
  const [model] = useState(() =>
    createTrailerPlayer({
      trailer,
      scope: trailerScopeKey,
      enabled: () =>
        flagOn("weapp.video.trailer.enabled") && (!feed || flagOn("weapp.trailer.feed")),
      now: Date.now,
      network: async () => (await Taro.getNetworkType()).networkType,
      fetch: trailerApi.playable,
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [readyEpoch, setReadyEpoch] = useState(-1);
  const [ended, setEnded] = useState(false);
  const detailControls = compact && !feed;
  const fullscreenEpoch = useRef<number | null>(null);
  const gatedPauseEpoch = useRef<number | null>(null);
  const fullscreenAttempt = useRef(0);
  const fullscreenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFullscreenWait = useCallback(() => {
    fullscreenAttempt.current++;
    if (fullscreenTimer.current !== null) clearTimeout(fullscreenTimer.current);
    fullscreenTimer.current = null;
  }, []);
  const [videoId] = useState(() => `catalog-trailer-${uuid()}`);
  // 换源使用独立原生 id；旧媒体事件和清理只能操作自己的播放器。
  const context = useCallback(
    (epoch: number) => Taro.createVideoContext(`${videoId}-${epoch}`),
    [videoId],
  );
  const stopNative = useCallback(
    (epoch: number) => {
      context(epoch)?.pause();
      if (fullscreenEpoch.current === epoch) {
        clearFullscreenWait();
        fullscreenEpoch.current = null;
        void Promise.resolve(exitTrailerFullscreen(`${videoId}-${epoch}`)).catch(() => undefined);
      }
    },
    [context, videoId, clearFullscreenWait],
  );
  const landscape = Boolean(state.dimensions && state.dimensions.width > state.dimensions.height);
  useEffect(() => onLandscapeChange?.(landscape), [landscape, onLandscapeChange]);
  useEffect(() => {
    model.mount();
    return () => {
      stopNative(model.snapshot().epoch);
      model.dispose();
    };
  }, [model, stopNative]);
  useEffect(() => {
    if (blocked || !enabled) stopNative(model.snapshot().epoch);
    model.block(blocked || !enabled);
  }, [model, blocked, enabled, stopNative]);
  useEffect(() => {
    const epoch = state.epoch;
    return () => stopNative(epoch);
  }, [state.epoch, stopNative]);
  useEffect(() => {
    if (!state.source || state.mobilePrompt) stopNative(state.epoch);
  }, [state.source, state.mobilePrompt, state.epoch, stopNative]);
  const fullscreenChanged = useCallback(
    (epoch: number, entered: boolean) => {
      if (!model.fullscreenChanged(epoch, entered)) {
        context(epoch)?.pause();
        if (entered)
          void Promise.resolve(exitTrailerFullscreen(`${videoId}-${epoch}`)).catch(() => undefined);
        return;
      }
      clearFullscreenWait();
      fullscreenEpoch.current = entered ? epoch : null;
      if (!entered && !model.snapshot().playing) context(epoch)?.pause();
    },
    [model, context, videoId, clearFullscreenWait],
  );
  useEffect(() => {
    if (!state.source || readyEpoch !== state.epoch) return;
    return watchTrailerFullscreen(`${videoId}-${state.epoch}`, (entered) =>
      fullscreenChanged(state.epoch, entered),
    );
  }, [state.source, state.epoch, readyEpoch, videoId, fullscreenChanged]);
  useEffect(() => {
    if (!state.source || readyEpoch !== state.epoch) return;
    if (model.canPlay(state.epoch)) context(state.epoch)?.play();
    else context(state.epoch)?.pause();
  }, [model, context, state.source, state.epoch, state.playing, readyEpoch]);
  useEffect(() => {
    if (state.source && readyEpoch === state.epoch)
      context(state.epoch)?.seek(model.snapshot().positionMs / 1000);
  }, [model, context, state.source, state.epoch, state.seekNo, readyEpoch]);
  useDidHide(() => {
    stopNative(model.snapshot().epoch);
    model.hide();
  });
  useDidShow(model.show);
  const play = () => {
    setEnded(false);
    if (state.playing) model.pause();
    else if (state.error) void model.retry();
    else void model.play();
  };
  const fullscreen = () => {
    const epoch = state.epoch;
    const direction = model.fullscreenRequest(epoch);
    if (direction === null || model.snapshot().fullscreen) return;
    clearFullscreenWait();
    const attempt = fullscreenAttempt.current;
    fullscreenEpoch.current = epoch;
    fullscreenTimer.current = setTimeout(() => {
      if (fullscreenAttempt.current !== attempt || fullscreenEpoch.current !== epoch) return;
      fullscreenTimer.current = null;
      fullscreenEpoch.current = null;
      model.fullscreenFailed(epoch);
    }, 2500);
    const failed = () => {
      if (fullscreenAttempt.current !== attempt) return;
      clearFullscreenWait();
      fullscreenEpoch.current = null;
      model.fullscreenFailed(epoch);
    };
    try {
      // H5 返回 Promise，微信原生接口返回 void；只显示固定文案，不暴露地址或平台异常。
      void Promise.resolve(requestTrailerFullscreen(`${videoId}-${epoch}`, direction)).catch(
        failed,
      );
    } catch {
      failed();
    }
  };
  const buttonText = state.error ? "重新获取播放地址" : state.playing ? "暂停预告片" : "播放预告片";
  return (
    <View
      className={`trailer-player${feed ? " trailer-player--feed" : ""}${detailControls ? " trailer-player--detail" : ""}${landscape ? " trailer-player--landscape" : ""}`}
      style={
        state.dimensions
          ? `--trailer-frame-padding: ${(state.dimensions.height / state.dimensions.width) * 100}%`
          : undefined
      }
    >
      <View className="trailer-player__frame">
        {state.source && enabled && !blocked ? (
          <Video
            key={state.epoch}
            id={`${videoId}-${state.epoch}`}
            className="trailer-player__video"
            src={state.source}
            autoplay={false}
            muted={state.muted}
            nativeProps={
              process.env.TARO_ENV === "h5"
                ? {
                    controls: state.fullscreen,
                    onVolumeChange: (event: Event) =>
                      model.mute(state.epoch, (event.target as HTMLVideoElement).muted),
                  }
                : undefined
            }
            controls={state.fullscreen}
            showCenterPlayBtn={state.fullscreen}
            showPlayBtn={state.fullscreen}
            showFullscreenBtn={state.fullscreen}
            showMuteBtn={false}
            enablePlayGesture={false}
            enableProgressGesture={state.fullscreen}
            initialTime={state.sourceAtMs / 1000}
            objectFit="contain"
            onLoadedMetaData={(event) => {
              if (!model.hasSource(state.epoch)) return;
              model.metadata(state.epoch, event.detail.width, event.detail.height);
              setReadyEpoch(state.epoch);
              context(state.epoch)?.seek(model.snapshot().positionMs / 1000);
              if (model.canPlay(state.epoch)) context(state.epoch)?.play();
            }}
            onPlay={() => {
              if (model.hasSource(state.epoch)) setEnded(false);
              if (model.canPlay(state.epoch)) return;
              if (model.hasSource(state.epoch) && model.snapshot().fullscreen)
                gatedPauseEpoch.current = state.epoch;
              context(state.epoch)?.pause();
              // 原生全屏的继续播放也走既有网络确认、开关、到期换签与身份守卫。
              void model.nativePlay(state.epoch);
            }}
            onPause={() => {
              if (gatedPauseEpoch.current === state.epoch) {
                gatedPauseEpoch.current = null;
                return;
              }
              if (model.hasSource(state.epoch)) model.pause(state.epoch);
            }}
            onTimeUpdate={(event) => model.time(state.epoch, event.detail.currentTime * 1000)}
            onEnded={() => {
              if (model.hasSource(state.epoch)) setEnded(true);
              model.ended(state.epoch);
            }}
            onError={() => model.failed(state.epoch)}
            onFullscreenChange={(event) => {
              // H5 原生事件会冒泡到 Taro 节点，但没有小程序 detail；由专属 watcher 接管。
              if (process.env.TARO_ENV === "h5" || !event.detail) return;
              fullscreenChanged(state.epoch, Boolean(event.detail.fullScreen));
            }}
          />
        ) : trailer.posterUrl?.url ? (
          <Image className="trailer-player__poster" src={trailer.posterUrl.url} mode="aspectFit" />
        ) : (
          <View className="trailer-player__placeholder">
            <View className="trailer-player__frame-line" />
            <View className="trailer-player__brand">狸有戏 · 预告片</View>
            <View className="trailer-player__title">{title}</View>
          </View>
        )}
        {!detailControls && !state.source && enabled ? (
          <View className="trailer-player__start">
            <Button
              size="lg"
              variant="secondary"
              icon="play-square"
              disabled={blocked}
              loading={state.busy}
              onClick={play}
            >
              {buttonText}
            </Button>
          </View>
        ) : null}
        {feed ? (
          <View className="trailer-player__mute trailer-player__controls">
            <TextButton tone="muted" disabled={blocked || !enabled} onClick={model.toggleMute}>
              {state.muted ? "已静音，开启声音" : "关闭声音"}
            </TextButton>
          </View>
        ) : null}
        {!detailControls ? (
          <View className="trailer-player__duration">预告片 {trailerTime(trailer.durationMs)}</View>
        ) : null}
        {detailControls && !state.fullscreen ? (
          <DetailTrailerControls
            key={state.epoch}
            source={Boolean(state.source)}
            ready={readyEpoch === state.epoch}
            playing={state.playing}
            muted={state.muted}
            busy={state.busy}
            ended={ended && Boolean(state.source)}
            disabled={blocked || !enabled}
            enabled={enabled}
            error={state.error}
            fullscreenError={state.fullscreenError}
            canFullscreen={
              !blocked &&
              enabled &&
              !state.busy &&
              Boolean(state.source && state.dimensions) &&
              readyEpoch === state.epoch
            }
            durationMs={trailer.durationMs}
            positionMs={state.positionMs}
            onPlay={play}
            onMute={model.toggleMute}
            onSeek={model.seek}
            onFullscreen={fullscreen}
          />
        ) : null}
        {children && !landscape ? (
          <View className="trailer-player__overlay">{children}</View>
        ) : null}
      </View>
      {children && landscape ? <View className="trailer-player__facts">{children}</View> : null}
      {!detailControls ? (
        <>
          <View className="trailer-player__controls">
            <Button
              size="sm"
              variant="secondary"
              disabled={blocked || !enabled}
              loading={state.busy}
              onClick={play}
            >
              {enabled ? buttonText : "预告片播放暂未开放"}
            </Button>
            <Button
              className="trailer-player__fullscreen"
              size="sm"
              variant="secondary"
              icon="fullscreen"
              disabled={
                blocked ||
                !enabled ||
                state.busy ||
                !state.source ||
                !state.dimensions ||
                readyEpoch !== state.epoch
              }
              onClick={fullscreen}
            >
              全屏观看
            </Button>
            {!feed ? (
              <TextButton tone="muted" disabled={blocked || !enabled} onClick={model.toggleMute}>
                {state.muted ? "已静音，开启声音" : "关闭声音"}
              </TextButton>
            ) : null}
          </View>
          <View className="trailer-player__progress">
            <Slider
              className="trailer-player__slider"
              ariaLabel="预告片播放进度"
              min={0}
              max={Math.max(1, Math.ceil(trailer.durationMs / 1000))}
              value={Math.floor(state.positionMs / 1000)}
              disabled={blocked || state.busy || !state.source}
              activeColor={sharedTokens.color.primary}
              backgroundColor={sharedTokens.color.border}
              blockColor={sharedTokens.color.primary}
              blockSize={12}
              onChange={(event) => model.seek(Number(event.detail.value) * 1000)}
            />
            <View className="trailer-player__time">
              {trailerTime(state.positionMs)} / {trailerTime(trailer.durationMs)}
            </View>
          </View>
          {state.error ? <View className="trailer-player__error">{state.error}</View> : null}
          {state.fullscreenError ? (
            <View className="trailer-player__error">{state.fullscreenError}</View>
          ) : null}
        </>
      ) : null}
      <Sheet
        visible={state.mobilePrompt && !blocked}
        title="使用移动网络播放"
        description="播放预告片会消耗手机流量，是否继续？"
        onClose={model.dismissMobile}
        footer={
          <>
            <Button block variant="secondary" onClick={model.dismissMobile}>
              暂不播放
            </Button>
            <Button block onClick={() => void model.acceptMobile()}>
              继续播放预告片
            </Button>
          </>
        }
      />
    </View>
  );
}
