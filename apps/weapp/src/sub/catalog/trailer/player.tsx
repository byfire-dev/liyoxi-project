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
import { trailerScopeKey } from "./scope";
import "./player.scss";

export function TrailerPlayer({
  trailer,
  title,
  feed = false,
  blocked = false,
  children,
}: {
  trailer: Trailer;
  title: string;
  feed?: boolean;
  blocked?: boolean;
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
  const readyEpoch = useRef(-1);
  const [videoId] = useState(() => `catalog-trailer-${uuid()}`);
  const context = useCallback(() => Taro.createVideoContext(videoId), [videoId]);
  useEffect(() => {
    model.mount();
    return () => {
      context()?.pause();
      model.dispose();
    };
  }, [model, context]);
  useEffect(() => {
    model.block(blocked || !enabled);
    if (blocked || !enabled) context()?.pause();
  }, [model, blocked, enabled, context]);
  useEffect(() => {
    if (!state.source || readyEpoch.current !== state.epoch) return;
    if (model.canPlay(state.epoch)) context()?.play();
    else context()?.pause();
  }, [model, context, state.source, state.epoch, state.playing]);
  useEffect(() => {
    if (state.source && readyEpoch.current === state.epoch)
      context()?.seek(model.snapshot().positionMs / 1000);
  }, [model, context, state.source, state.epoch, state.seekNo]);
  useDidHide(() => {
    context()?.pause();
    model.hide();
  });
  useDidShow(model.show);
  const play = () => {
    if (state.playing) model.pause();
    else if (state.error) void model.retry();
    else void model.play();
  };
  const buttonText = state.error ? "重新获取播放地址" : state.playing ? "暂停预告片" : "播放预告片";
  return (
    <View className={`trailer-player${feed ? " trailer-player--feed" : ""}`}>
      <View className="trailer-player__frame">
        {state.source && enabled && !blocked ? (
          <Video
            key={state.epoch}
            id={videoId}
            className="trailer-player__video"
            src={state.source}
            autoplay={false}
            muted={state.muted}
            controls={false}
            showCenterPlayBtn={false}
            showPlayBtn={false}
            showFullscreenBtn={false}
            enablePlayGesture={false}
            enableProgressGesture={false}
            initialTime={state.sourceAtMs / 1000}
            objectFit="contain"
            onLoadedMetaData={() => {
              if (!model.hasSource(state.epoch)) return;
              readyEpoch.current = state.epoch;
              context()?.seek(model.snapshot().positionMs / 1000);
              if (model.canPlay(state.epoch)) context()?.play();
            }}
            onPlay={() => {
              if (!model.canPlay(state.epoch)) context()?.pause();
            }}
            onPause={() => {
              if (model.hasSource(state.epoch)) model.pause(state.epoch);
            }}
            onTimeUpdate={(event) => model.time(state.epoch, event.detail.currentTime * 1000)}
            onEnded={() => model.ended(state.epoch)}
            onError={() => model.failed(state.epoch)}
          />
        ) : trailer.posterUrl?.url ? (
          <Image className="trailer-player__poster" src={trailer.posterUrl.url} mode="aspectFill" />
        ) : (
          <View className="trailer-player__placeholder">
            <View className="trailer-player__frame-line" />
            <View className="trailer-player__brand">狸有戏 · 预告片</View>
            <View className="trailer-player__title">{title}</View>
          </View>
        )}
        {!state.source && enabled ? (
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
        <View className="trailer-player__duration">预告片 {trailerTime(trailer.durationMs)}</View>
        {children ? <View className="trailer-player__overlay">{children}</View> : null}
      </View>
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
