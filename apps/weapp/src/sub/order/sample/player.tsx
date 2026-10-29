import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Slider, Video, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { sharedTokens } from "@liyoxi/shared/design/tokens";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import { flagOn } from "@/stores/bootstrap";
import { deliveryScopeKey } from "@/stores/delivery";
import type { Sample } from "../components/delivery-api";
import { createSamplePlayer } from "./player-model";
import { sampleTime } from "./model";
import "./player.scss";

interface Props {
  sample: NonNullable<Sample>;
  blocked: boolean;
  reload(): Promise<Sample>;
  replace(view: Sample, current: () => boolean): void;
}

/** 样片页私有播放器；播放、续播和定位都经过首次移动网络提示。 */
export function SamplePlayer(props: Props) {
  const [model] = useState(() =>
    createSamplePlayer({
      sample: props.sample,
      scope: deliveryScopeKey,
      enabled: () => flagOn("weapp.video.sample.enabled"),
      now: Date.now,
      network: async () => (await Taro.getNetworkType()).networkType,
      // 页面按门店/订单项挂载，本次生命期内两端口始终属于同一个父resource。
      reload: props.reload,
      replace: props.replace,
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [width, setWidth] = useState(() => Math.max(1, Taro.getWindowInfo().windowWidth - 64));
  const readyEpoch = useRef(-1);
  const videoId = "sample-video",
    frameId = "sample-video-frame";
  const context = () => Taro.createVideoContext(videoId);
  useEffect(() => {
    model.mount();
    Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select(`#${frameId}`)
        .boundingClientRect((rect) => {
          if (!Array.isArray(rect) && rect?.width) setWidth(rect.width);
        })
        .exec();
    });
    return () => {
      context()?.pause();
      model.dispose();
    };
  }, [model]);
  useEffect(() => {
    model.block(props.blocked);
  }, [model, props.blocked]);
  useLayoutEffect(() => {
    model.sync(props.sample);
  }, [model, props.sample]);
  useEffect(() => {
    if (!state.source || readyEpoch.current !== state.epoch) return;
    if (model.canPlay(state.epoch)) context()?.play();
    else context()?.pause();
  }, [model, state.epoch, state.source, state.playing]);
  useEffect(() => {
    if (state.source && readyEpoch.current === state.epoch)
      context()?.seek(model.snapshot().positionMs / 1000);
  }, [model, state.source, state.epoch, state.seekNo]);
  useDidHide(() => {
    context()?.pause();
    model.hide();
  });
  useDidShow(model.show);
  const playable = props.sample.playable;
  return (
    <View className="sample-player">
      <View
        id={frameId}
        className="sample-player__frame"
        style={{ height: `${(width * 16) / 9}px` }}
      >
        {state.source && !props.blocked ? (
          <Video
            key={state.epoch}
            id={videoId}
            className="sample-player__video"
            src={state.source}
            autoplay={false}
            muted={playable?.muted ?? false}
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
              if (model.hasSource(state.epoch)) model.pause();
            }}
            onTimeUpdate={(event) => model.time(state.epoch, event.detail.currentTime * 1000)}
            onEnded={() => model.ended(state.epoch)}
            onError={() => model.failed(state.epoch)}
          />
        ) : playable?.posterUrl ? (
          <Image className="sample-player__poster" src={playable.posterUrl} mode="aspectFit" />
        ) : (
          <View className="sample-player__placeholder">第 {props.sample.versionNo} 版样片</View>
        )}
      </View>
      <View className="sample-player__controls">
        <Button
          size="sm"
          variant="secondary"
          disabled={props.blocked}
          loading={state.busy}
          onClick={() => {
            if (state.playing) model.pause();
            else if (state.error) void model.retry();
            else void model.play();
          }}
        >
          {state.error
            ? "重新获取播放地址"
            : state.playing
              ? "暂停样片"
              : state.source
                ? "继续播放"
                : "播放样片"}
        </Button>
        <View className="sample-player__time">
          {sampleTime(state.positionMs)} / {sampleTime(props.sample.durationMs)}
        </View>
      </View>
      <Slider
        ariaLabel="样片播放进度"
        min={0}
        max={Math.max(1, Math.ceil(props.sample.durationMs / 1000))}
        value={Math.floor(state.positionMs / 1000)}
        disabled={props.blocked || state.busy}
        activeColor={sharedTokens.color.primary}
        backgroundColor={sharedTokens.color.border}
        blockColor={sharedTokens.color.primary}
        blockSize={16}
        onChange={(event) => model.seek(Number(event.detail.value) * 1000)}
      />
      {state.error ? <View className="delivery-caption">{state.error}</View> : null}
      {props.sample.adSlots.length ? (
        <View className="sample-player__slots">
          {props.sample.adSlots.map((slot) => (
            <Button
              key={slot.slot}
              size="sm"
              variant="outline"
              disabled={props.blocked || state.busy}
              onClick={() => model.seek(slot.startMs)}
            >
              定位{slot.slot === "opening" ? "片头" : "片尾"} {sampleTime(slot.startMs)}～
              {sampleTime(slot.endMs)} · {slot.label}
            </Button>
          ))}
        </View>
      ) : null}
      <Sheet
        visible={state.mobilePrompt && !props.blocked}
        title="使用移动网络播放"
        description="播放样片会消耗手机流量，是否继续？"
        onClose={model.dismissMobile}
        footer={
          <>
            <Button block variant="secondary" onClick={model.dismissMobile}>
              暂不播放
            </Button>
            <Button block onClick={() => void model.acceptMobile()}>
              继续播放样片
            </Button>
          </>
        }
      />
    </View>
  );
}
