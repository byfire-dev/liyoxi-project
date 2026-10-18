import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Taro from "@tarojs/taro";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { profileContext } from "./runtime";
import {
  createMediaPreview,
  createPreviewDownloader,
  mediaPreviewView,
  type PreviewImage,
} from "./media-preview";

const download = createPreviewDownloader((url) => {
  const task = Taro.downloadFile({ url, timeout: 15_000 });
  return { promise: task, abort: () => task.abort() };
});

export function useMediaPreview(images: readonly PreviewImage[]) {
  const [preview] = useState(() => createMediaPreview({ context: profileContext, download }));
  const state = useSyncExternalStore(preview.subscribe, preview.snapshot, preview.snapshot);
  const context = profileContext();
  const input = JSON.stringify(images);
  const stableImages = useMemo(() => JSON.parse(input) as readonly PreviewImage[], [input]);
  useEffect(() => {
    preview.activate();
    const offContext = useContextStore.subscribe((state, previous) => {
      if (state.contextRev !== previous.contextRev) preview.reset();
    });
    const offSession = useSessionStore.subscribe((state, previous) => {
      if (state.accessToken !== previous.accessToken) preview.reset();
    });
    return () => {
      preview.dispose();
      offContext();
      offSession();
    };
  }, [preview]);
  useEffect(() => {
    preview.setImages(stableImages);
  }, [preview, stableImages, context]);
  return useMemo(
    () => ({ ...mediaPreviewView(state, stableImages, context), retry: preview.retry }),
    [preview, state, stableImages, context],
  );
}
