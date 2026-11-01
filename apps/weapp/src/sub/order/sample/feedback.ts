import type { Body } from "@/lib/account-api";
import type { Sample } from "../components/delivery-api";
import type { createSampleApi } from "./api";
import { sampleIdentity, samplePlaybackBlocker } from "./model";
export interface FeedbackImage {
  fileId: string;
  src: string;
}
export function sampleFeedbackBody(
  sample: Sample | null,
  note: string,
  files: readonly FeedbackImage[],
  enabled: boolean,
): Body<"m.sample.requestChange"> {
  if (
    !sample ||
    sample.status !== "pushed" ||
    sample.isPaused ||
    sample.ticketStep !== "sample_confirm" ||
    !sample.actions.includes("request-change") ||
    samplePlaybackBlocker(sample, enabled)
  )
    throw new Error("当前样片不可提交修改，请刷新或联系服务经理");
  const text = note.trim();
  if (!text || [...text].length > 200) throw new Error("请填写1至200字合成修改说明");
  const ids = files.map((file) => file.fileId);
  if (ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !id))
    throw new Error("请使用最多3张已上传的不同截图");
  return { feedbackKind: "compose", note: text, ...(ids.length ? { imageFileIds: ids } : {}) };
}
/** A retry retains the exact body/key; context/version changes invalidate every continuation. */
export function createSampleFeedback(deps: {
  api: Pick<ReturnType<typeof createSampleApi>, "requestChange" | "sample">;
  scope(): string;
  sample(): Sample | null;
  enabled(): boolean;
  key(): string;
  itemId: string;
  replace(view: Sample, current: () => boolean): void;
}) {
  let live = true,
    busy = false,
    intent: { fingerprint: string; key: string } | null = null;
  return {
    dispose: () => {
      live = false;
      intent = null;
    },
    mount: () => {
      live = true;
    },
    async submit(note: string, files: readonly FeedbackImage[], outer: () => boolean) {
      if (!live || busy) return false;
      const view = deps.sample();
      const body = sampleFeedbackBody(view, note, files, deps.enabled());
      const identity = sampleIdentity(view!),
        scope = deps.scope();
      const current = () =>
        live &&
        outer() &&
        deps.scope() === scope &&
        Boolean(deps.sample() && sampleIdentity(deps.sample()!) === identity) &&
        deps.enabled();
      if (!current()) return false;
      const fingerprint = JSON.stringify({ identity, body });
      if (intent?.fingerprint !== fingerprint) intent = { fingerprint, key: deps.key() };
      busy = true;
      try {
        await deps.api.requestChange(view!.sampleId, body, intent.key);
        if (!current()) return false;
        const fresh = await deps.api.sample(deps.itemId);
        if (!current()) return false;
        if (fresh?.sampleId === view!.sampleId && fresh.status !== "change_requested")
          throw new Error("修改状态尚未更新，请刷新确认");
        deps.replace(fresh, current);
        return true;
      } finally {
        busy = false;
      }
    },
  };
}
type UploadJob = {
  start(): Promise<{ fileId: string } | null>;
  retry(): Promise<{ fileId: string } | null>;
  cancel(): Promise<unknown>;
  dispose(): void;
};
export function createFeedbackUpload(
  job: UploadJob,
  current: () => boolean,
  stored: (id: string) => void,
) {
  let live = true,
    busy = false,
    delivered = false;
  return {
    async finish(retry = false) {
      if (!live || busy || delivered) return;
      busy = true;
      try {
        const file = await (retry ? job.retry() : job.start());
        if (live && current() && file) {
          delivered = true;
          stored(file.fileId);
          job.dispose();
        }
      } finally {
        busy = false;
      }
    },
    remove() {
      live = false;
      return job.cancel();
    },
    dispose() {
      live = false;
      job.dispose();
    },
  };
}
