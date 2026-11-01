import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { Image, Video, View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { flagOn } from "@/stores/bootstrap";
import { deliveryScopeKey } from "@/stores/delivery";
import { adApi, type Ad } from "./api";
import { adIdentity, adError, adPlaybackSource } from "./model";
const videoContext = () => Taro.createVideoContext("ad-video");

/** Private ad player: every new source is fetched for this exact version and owner scope. */
export function AdPlayer({
  ad,
  blocked,
  replace,
}: {
  ad: Ad;
  blocked: boolean;
  replace(value: Ad, current: () => boolean): void;
}) {
  const [source, setSource] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [mobile, setMobile] = useState(false);
  const life = useRef({ live: true, hidden: false, generation: 0, mobile: false, blocked });
  const scope = useRef(deliveryScopeKey()),
    identity = useRef(adIdentity(ad)),
    expires = useRef(0);
  const stop = useCallback(() => {
    life.current.generation++;
    videoContext()?.pause();
    setSource(null);
    setBusy(false);
    setMobile(false);
  }, []);
  useEffect(() => {
    const current = life.current;
    current.live = true;
    return () => {
      current.live = false;
      current.generation++;
      videoContext()?.pause();
    };
  }, []);
  useLayoutEffect(() => {
    life.current.blocked = blocked;
    if (blocked) {
      const generation = ++life.current.generation;
      videoContext()?.pause();
      void Promise.resolve().then(() => {
        if (life.current.live && life.current.blocked && life.current.generation === generation)
          stop();
      });
    }
  }, [blocked, stop]);
  useDidHide(() => {
    life.current.hidden = true;
    stop();
  });
  useDidShow(() => {
    life.current.hidden = false;
  });
  const valid = () =>
    life.current.live &&
    !life.current.hidden &&
    !life.current.blocked &&
    scope.current === deliveryScopeKey() &&
    flagOn("weapp.video.ad.enabled");
  const play = async (accepted = false) => {
    if (!valid() || busy) return;
    const generation = ++life.current.generation,
      current = () => valid() && generation === life.current.generation;
    setBusy(true);
    setError(null);
    try {
      let network = "unknown";
      try {
        network = (await Taro.getNetworkType()).networkType;
      } catch {
        /* Unknown also needs the mobile prompt. */
      }
      if (!current()) return;
      if (network === "none") throw new Error("网络未连接，请联网后重试");
      if (network !== "wifi" && !life.current.mobile && !accepted) {
        setMobile(true);
        return;
      }
      if (accepted) life.current.mobile = true;
      setMobile(false);
      const fresh = await adApi.get(ad.adId);
      if (!current()) return;
      replace(fresh, current);
      if (adIdentity(fresh) !== identity.current) {
        stop();
        return;
      }
      if (
        !fresh.currentVersion?.previewChannels.includes("weapp") ||
        !fresh.playable ||
        fresh.playable.kind !== "ad"
      )
        throw new Error("当前版本不支持小程序播放，请使用允许的查看方式");
      const playable = await adApi.playable(fresh.playable.playableId);
      if (!current()) return;
      const next = adPlaybackSource(fresh, playable, Date.now());
      expires.current = Date.parse(playable.expiresAt!);
      setSource(next);
    } catch (cause) {
      if (current()) {
        setSource(null);
        setError(adError(cause));
      }
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <View className="ad-player">
      {source && !blocked ? (
        <Video
          id="ad-video"
          key={source}
          src={source}
          autoplay={false}
          controls
          objectFit="contain"
          onLoadedMetaData={() => {
            if (valid() && expires.current > Date.now() + 5000) videoContext()?.play();
          }}
          onPlay={() => {
            if (!valid() || expires.current <= Date.now() + 5000) {
              stop();
              setError("播放地址已过期，请重新获取播放地址");
            }
          }}
          onError={() => {
            stop();
            setError("播放失败，请重新获取播放地址");
          }}
        />
      ) : ad.playable?.posterUrl ? (
        <Image src={ad.playable.posterUrl} mode="aspectFit" />
      ) : (
        <View className="ad-player__placeholder">第 {ad.currentVersionNo} 版广告</View>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={blocked}
        loading={busy}
        onClick={() => void play()}
      >
        播放当前版广告
      </Button>
      {error ? <Note tone="warning">{error}</Note> : null}
      <Sheet
        visible={mobile}
        title="使用移动网络播放"
        description="播放广告会消耗手机流量，是否继续？"
        onClose={() => setMobile(false)}
        footer={
          <Button block onClick={() => void play(true)}>
            继续播放广告
          </Button>
        }
      />
    </View>
  );
}
