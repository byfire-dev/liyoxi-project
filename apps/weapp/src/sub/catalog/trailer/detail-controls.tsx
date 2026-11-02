import { useEffect, useState } from "react";
import { Slider, Text, View } from "@tarojs/components";
import { merchantTokens, sharedTokens } from "@liyoxi/shared/design/tokens";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { trailerTime } from "./player-model";
import "./detail-controls.scss";

/** Detail-only presentation. Playback and authorization remain in the shared player model. */
export function DetailTrailerControls({
  source,
  ready,
  playing,
  muted,
  busy,
  ended,
  disabled,
  enabled,
  error,
  fullscreenError,
  canFullscreen,
  durationMs,
  positionMs,
  onPlay,
  onMute,
  onSeek,
  onFullscreen,
}: {
  source: boolean;
  ready: boolean;
  playing: boolean;
  muted: boolean;
  busy: boolean;
  ended: boolean;
  disabled: boolean;
  enabled: boolean;
  error: string | null;
  fullscreenError: string | null;
  canFullscreen: boolean;
  durationMs: number;
  positionMs: number;
  onPlay(): void;
  onMute(): void;
  onSeek(ms: number): void;
  onFullscreen(): void;
}) {
  const [visible, setVisible] = useState(true);
  const [interaction, setInteraction] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [seekSeconds, setSeekSeconds] = useState<number | null>(null);
  const [soundHint, setSoundHint] = useState(true);
  const loading = busy || (source && !ready);
  const reveal = () => {
    setVisible(true);
    setInteraction((value) => value + 1);
  };
  useEffect(() => {
    if (!playing || !ready || disabled || loading || dragging || error || fullscreenError) return;
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [playing, ready, disabled, loading, dragging, error, fullscreenError, interaction]);
  useEffect(() => {
    if (!ready || !playing || !muted || !soundHint) return;
    const timer = setTimeout(() => setSoundHint(false), 2500);
    return () => clearTimeout(timer);
  }, [ready, playing, muted, soundHint]);
  // A cancelled touch never leaves the progress slider in its held-open state.
  const releaseSeek = () => {
    setDragging(false);
    setSeekSeconds(null);
    reveal();
  };
  const centre = !source || ended || Boolean(error);
  const action = error ? "重试" : ended ? "重播" : "播放预告片";
  const message = error?.includes("播放地址") ? "播放已中断，请重试" : error;
  return (
    <View className="detail-trailer-controls">
      {loading ? (
        <View className="detail-trailer-controls__centre" ariaLabel="正在加载预告片">
          <View className="detail-trailer-controls__spinner" />
        </View>
      ) : !enabled ? (
        <View className="detail-trailer-controls__centre detail-trailer-controls__message">
          预告片播放暂未开放
        </View>
      ) : centre ? (
        <View className="detail-trailer-controls__centre">
          {message ? <View className="detail-trailer-controls__message">{message}</View> : null}
          <View
            className={`detail-trailer-controls__start${disabled ? " detail-trailer-controls__start--disabled" : ""}`}
            ariaRole="button"
            ariaLabel={action}
            onClick={
              disabled
                ? undefined
                : () => {
                    reveal();
                    onPlay();
                  }
            }
          >
            {error || ended ? (
              <Icon name="refresh" size={24} />
            ) : (
              <View className="detail-trailer-controls__play-icon" />
            )}
          </View>
          {error || ended ? (
            <Text className="detail-trailer-controls__caption">{action}</Text>
          ) : null}
        </View>
      ) : (
        <>
          <View
            className="detail-trailer-controls__surface"
            ariaRole="button"
            ariaLabel="显示播放控件"
            onClick={reveal}
          />
          {visible || !playing || dragging ? (
            <View
              className="detail-trailer-controls__bar"
              onClick={reveal}
              onTouchStart={() => setDragging(true)}
              onTouchEnd={releaseSeek}
              onTouchCancel={releaseSeek}
            >
              <Slider
                className="detail-trailer-controls__slider"
                ariaLabel="预告片播放进度"
                min={0}
                max={Math.max(1, Math.ceil(durationMs / 1000))}
                value={seekSeconds ?? Math.floor(positionMs / 1000)}
                disabled={disabled || loading}
                activeColor={sharedTokens.color.primary}
                backgroundColor={merchantTokens.color["fill-on-dark"]}
                blockColor={sharedTokens.color["text-inverse"]}
                blockSize={12}
                onChanging={(event) => {
                  setDragging(true);
                  setSeekSeconds(Number(event.detail.value));
                }}
                onChange={(event) => {
                  onSeek(Number(event.detail.value) * 1000);
                  releaseSeek();
                }}
              />
              <View className="detail-trailer-controls__row">
                <View
                  className="detail-trailer-controls__toggle"
                  ariaRole="button"
                  ariaLabel={playing ? "暂停预告片" : "播放预告片"}
                  onClick={disabled ? undefined : onPlay}
                >
                  <View
                    className={
                      playing
                        ? "detail-trailer-controls__pause-icon"
                        : "detail-trailer-controls__play-icon"
                    }
                  />
                </View>
                <Text className="detail-trailer-controls__time">
                  {trailerTime(seekSeconds === null ? positionMs : seekSeconds * 1000)} /{" "}
                  {trailerTime(durationMs)}
                </Text>
                <View className="detail-trailer-controls__sound">
                  {soundHint && muted && playing ? (
                    <Text className="detail-trailer-controls__sound-hint">开启声音</Text>
                  ) : null}
                  <IconButton
                    icon={muted ? "volume-off" : "volume"}
                    label={muted ? "开启声音" : "关闭声音"}
                    disabled={disabled}
                    onClick={() => {
                      setSoundHint(false);
                      onMute();
                    }}
                  />
                </View>
                <IconButton
                  className="trailer-player__fullscreen"
                  icon="fullscreen"
                  label="全屏观看"
                  disabled={!canFullscreen}
                  onClick={onFullscreen}
                />
              </View>
              {fullscreenError ? (
                <View className="detail-trailer-controls__fullscreen-error">{fullscreenError}</View>
              ) : null}
            </View>
          ) : null}
        </>
      )}
      {!source && !error && !loading && enabled ? (
        <Text className="detail-trailer-controls__duration">{trailerTime(durationMs)}</Text>
      ) : null}
    </View>
  );
}
