import Taro from "@tarojs/taro";

export function requestTrailerFullscreen(id: string, direction: 0 | 90) {
  return Taro.createVideoContext(id).requestFullScreen({ direction });
}

export function exitTrailerFullscreen(id: string) {
  return Taro.createVideoContext(id).exitFullScreen();
}

/** 微信全屏事件由 Video 的 onFullscreenChange 接收。 */
export function watchTrailerFullscreen(_id: string, _changed: (entered: boolean) => void) {
  return () => undefined;
}
