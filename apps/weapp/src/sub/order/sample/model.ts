import type { Sample } from "../components/delivery-api";

export const sampleIdentity = (view: NonNullable<Sample>) => `${view.sampleId}:${view.versionNo}`;

export function samplePlaybackBlocker(view: Sample | null, enabled: boolean): string | null {
  if (!enabled) return "小程序样片查看暂不可用，请联系服务经理";
  if (!view || !view.previewChannels.includes("weapp"))
    return "此版本暂不支持小程序查看，请联系服务经理";
  if (view.status === "superseded") return "此版本已失效，请刷新查看当前样片";
  if (!view.playable?.sources.length || view.playable.kind !== "sample")
    return "样片暂不可播放，请刷新或联系服务经理";
  return null;
}

export function sampleConfirmation(view: Sample, checked: boolean, enabled = true) {
  if (!checked) throw new Error("请先勾选“我已查看”");
  const blocker = samplePlaybackBlocker(view, enabled);
  if (blocker) throw new Error(blocker);
  if (!view?.confirmableVia.includes("weapp") || !view.actions.includes("confirm"))
    throw new Error("当前样片不可确认，请刷新或联系服务经理");
  return { versionNo: view.versionNo, viewedVia: "weapp" as const, hasViewed: true };
}

export const sampleTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
