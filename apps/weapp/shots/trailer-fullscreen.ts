type BrowserVideo = HTMLVideoElement & {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitDisplayingFullscreen?: boolean;
};
const browserVideo = (id: string) =>
  globalThis.document.getElementById(id)?.querySelector<BrowserVideo>("video");

/** Taro H5 不转发浏览器全屏拒绝；离线截图使用真实浏览器接口保留失败反馈。 */
export function requestTrailerFullscreen(id: string, _direction: 0 | 90) {
  const video = browserVideo(id);
  if (video?.requestFullscreen) return video.requestFullscreen();
  if (video?.webkitEnterFullscreen) return video.webkitEnterFullscreen();
  throw new Error("Fullscreen unavailable");
}

export function exitTrailerFullscreen(id: string) {
  const video = browserVideo(id);
  if (video && globalThis.document.fullscreenElement === video)
    return globalThis.document.exitFullscreen();
  if (video?.webkitDisplayingFullscreen) return video.webkitExitFullscreen?.();
}

export function watchTrailerFullscreen(id: string, changed: (entered: boolean) => void) {
  const video = browserVideo(id);
  if (!video) return () => undefined;
  const sync = () =>
    changed(
      globalThis.document.fullscreenElement === video || video.webkitDisplayingFullscreen === true,
    );
  globalThis.document.addEventListener("fullscreenchange", sync);
  video.addEventListener("webkitbeginfullscreen", sync);
  video.addEventListener("webkitendfullscreen", sync);
  return () => {
    globalThis.document.removeEventListener("fullscreenchange", sync);
    video.removeEventListener("webkitbeginfullscreen", sync);
    video.removeEventListener("webkitendfullscreen", sync);
    // React 卸载后节点已离开文档，仍持有本代媒体引用以停止潜在的后台声音。
    video.pause();
    if (globalThis.document.fullscreenElement === video)
      void globalThis.document.exitFullscreen().catch(() => undefined);
    else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
  };
}
