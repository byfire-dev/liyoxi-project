import { ApiError } from "@/lib/request";
import type { SelectedFile, UploadJob } from "@/lib/upload/queue";
import type { AssetDetail } from "./api";
import type { AssetDetailApi, FeedbackBody, PortraitBody } from "./detail-api";
import type { PortraitPorts } from "./portrait-platform";

type Entry = {
  key: string;
  token: string;
  file: SelectedFile;
  fileId: string | null;
  cancelKey: string;
  stored: boolean;
  job: UploadJob;
  remove(): void;
};
type Intent<B> = { body: B; key: string };
export interface DetailActionState {
  feedbackOpen: boolean;
  content: string;
  dimension: FeedbackBody["dimension"];
  feedbackBusy: boolean;
  feedbackPending: boolean;
  feedbackMessage: string | null;
  portraitOpen: boolean;
  portraitBusy: boolean;
  portraitPending: boolean;
  portraitMessage: string | null;
  cancelPending: boolean;
  files: { key: string; name: string; status: string; progress: number; message: string | null }[];
}
const failure = (error: unknown): string => {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      ASSET_FEEDBACK_DAILY_LIMIT: "今天对这条素材的反馈已满5次，请明天再试",
      NOT_FOUND: "素材不存在或已移除，请刷新详情",
      PERMISSION_DENIED: "当前成员不能补交此素材的授权材料，请刷新详情",
      ASSET_PORTRAIT_AUTH_FORBIDDEN: "当前成员不能补交此素材的授权材料，请刷新详情",
      FORBIDDEN: "门店权限已变化，请重新选择门店",
      NOT_A_MEMBER: "门店权限已变化，请重新选择门店",
      CAPABILITY_DENIED: "当前门店不能执行此操作，请刷新详情",
      STATE_NOT_ALLOWED: "素材状态已变化，请刷新详情后核对",
      FILE_NOT_USABLE: "授权文件尚不可用，请核对上传结果后重试",
      VALIDATION_FAILED: "内容或材料数量不符合要求，请核对后重试",
      IDEMPOTENCY_KEY_REUSED: "本次提交意图不一致，请刷新详情核对",
      IDEMPOTENCY_EXPIRED: "本次提交已过期，请刷新详情核对",
    };
    if (messages[error.error]) return messages[error.error]!;
  }
  return "提交结果尚未确认，请重试确认本次提交";
};
const uncertain = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status === 0 ||
  error.status >= 500 ||
  ["IDEMPOTENCY_IN_PROGRESS", "BUSY"].includes(error.error);

/** 页面私有意图；公共上传协议、文件取消和业务权限仍由既有端口决定。 */
export function createAssetDetailActions(deps: {
  id: string;
  scope(): string | null;
  detail(): AssetDetail | null;
  api: AssetDetailApi;
  key(action: string): string;
  ports(current: () => boolean): Promise<PortraitPorts>;
  refresh(): Promise<void>;
}) {
  const owner = deps.scope(),
    listeners = new Set<() => void>();
  let alive = true,
    visible = true,
    generation = 0;
  let feedbackFlight: object | null = null,
    portraitFlight: object | null = null;
  let uploadFlight: object | null = null,
    cancelFlight: object | null = null;
  let selecting = false,
    uploading: Promise<void> | null = null,
    cancelling: Promise<void> | null = null;
  let feedbackIntent: Intent<FeedbackBody> | null = null,
    portraitIntent: Intent<PortraitBody> | null = null;
  let ports: Promise<PortraitPorts> | null = null;
  let entries: Entry[] = [];
  let state: DetailActionState = {
    feedbackOpen: false,
    content: "",
    dimension: undefined,
    feedbackBusy: false,
    feedbackPending: false,
    feedbackMessage: null,
    portraitOpen: false,
    portraitBusy: false,
    portraitPending: false,
    portraitMessage: null,
    cancelPending: false,
    files: [],
  };
  const base = () => alive && owner !== null && deps.scope() === owner;
  const current = (own = generation) => base() && visible && own === generation;
  const allowed = (action: "feedback" | "portrait-auth") =>
    current() && deps.detail()?.actions.includes(action) === true;
  const publish = (patch: Partial<DetailActionState> = {}) => {
    if (!current()) return;
    state = {
      ...state,
      ...patch,
      feedbackBusy: feedbackFlight !== null,
      portraitBusy:
        selecting || uploading !== null || cancelling !== null || portraitFlight !== null,
      files: entries.map((entry) => {
        const value = entry.job.snapshot();
        if (value.fileId) entry.fileId = value.fileId;
        return {
          key: entry.key,
          name: entry.file.name,
          status: entry.stored ? "stored" : value.status === "stored" ? "failed" : value.status,
          progress: value.progress,
          message: value.message,
        };
      }),
    };
    listeners.forEach((run) => run());
  };
  const getPorts = () =>
    (ports ??= deps
      .ports(() => current())
      .catch((error: unknown) => {
        ports = null;
        throw error;
      }));
  const finishEntries = () => {
    entries.forEach((entry) => {
      entry.remove();
      entry.job.dispose();
    });
    entries = [];
  };
  const upload = (): Promise<void> => {
    if (uploading) return uploading;
    if (!allowed("portrait-auth") || state.cancelPending || portraitIntent || cancelling)
      return Promise.resolve();
    const own = generation,
      flight = {};
    uploadFlight = flight;
    const work: Promise<void> = (async () => {
      await Promise.resolve();
      try {
        for (const entry of entries) {
          if (!current(own)) return;
          if (entry.stored) continue;
          const result = await (entry.job.snapshot().status === "queued"
            ? entry.job.start()
            : entry.job.retry());
          if (!current(own)) return;
          if (
            result?.status === "stored" &&
            result.category === "portrait_auth" &&
            result.moderationState !== "block"
          ) {
            entry.fileId = result.fileId;
            entry.stored = true;
          }
          publish({
            portraitMessage:
              result && !entry.stored ? "授权文件分类或入库结果不符，请取消本次上传" : null,
          });
        }
      } catch {
        if (current(own)) publish({ portraitMessage: "材料上传未完成，请重试原文件" });
      } finally {
        if (uploadFlight === flight) {
          uploadFlight = null;
          uploading = null;
        }
        // 只释放自身的同步闩，旧请求不能释放后来操作的锁。
        publish();
      }
    })();
    uploading = work;
    publish();
    return work;
  };
  return {
    snapshot: () => state,
    subscribe(run: () => void) {
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    openFeedback() {
      if (allowed("feedback")) publish({ feedbackOpen: true, feedbackMessage: null });
    },
    editFeedback(content: string, dimension?: FeedbackBody["dimension"]) {
      if (!allowed("feedback") || feedbackFlight || state.feedbackPending) return;
      feedbackIntent = null;
      publish({ content, dimension, feedbackMessage: null });
    },
    async feedback() {
      if (!allowed("feedback") || feedbackFlight) return;
      const content = state.content.trim();
      if (!content || content.length > 200) {
        publish({ feedbackMessage: "请输入1–200字反馈" });
        return;
      }
      feedbackIntent ??= {
        body: { content, ...(state.dimension ? { dimension: state.dimension } : {}) },
        key: deps.key("asset_feedback"),
      };
      const intent = feedbackIntent,
        own = generation,
        flight = {};
      feedbackFlight = flight;
      publish({ feedbackMessage: null, feedbackPending: true });
      try {
        await deps.api.feedback(deps.id, intent.body, intent.key);
        if (!current(own)) return;
        feedbackIntent = null;
        publish({
          feedbackPending: false,
          content: "",
          feedbackMessage: "反馈已提交，交付经理将核对标签",
        });
      } catch (error) {
        if (current(own))
          publish({ feedbackPending: uncertain(error), feedbackMessage: failure(error) });
      } finally {
        if (feedbackFlight === flight) feedbackFlight = null;
        publish();
      }
    },
    openPortrait() {
      if (allowed("portrait-auth")) publish({ portraitOpen: true, portraitMessage: null });
    },
    async choose(kind: "image" | "pdf") {
      if (
        !allowed("portrait-auth") ||
        selecting ||
        uploading ||
        cancelling ||
        portraitFlight ||
        portraitIntent ||
        state.cancelPending ||
        entries.length >= 9
      )
        return;
      const own = generation;
      selecting = true;
      publish({ portraitMessage: null });
      try {
        const native = await getPorts();
        if (!current(own) || !allowed("portrait-auth")) return;
        const files = await native.choose(kind, 9 - entries.length);
        if (!current(own) || !allowed("portrait-auth")) return;
        for (const file of files.slice(0, 9 - entries.length)) {
          const token = await native.fingerprint(file);
          if (!current(own) || !allowed("portrait-auth")) return;
          if (entries.some((entry) => entry.token === token)) continue;
          const job = native.job(file);
          const entry: Entry = {
            key: deps.key("portrait_file"),
            token,
            file,
            fileId: null,
            cancelKey: deps.key("file_cancel"),
            stored: false,
            job,
            remove: () => {},
          };
          entry.remove = job.subscribe(() => publish());
          entries.push(entry);
          publish();
        }
      } catch {
        if (current(own))
          publish({ portraitMessage: "未能选择授权材料，请检查隐私授权及JPG、PNG或PDF格式后重试" });
      } finally {
        selecting = false;
        publish();
      }
      if (current(own)) await upload();
    },
    upload,
    async portrait() {
      if (
        !allowed("portrait-auth") ||
        selecting ||
        uploading ||
        cancelling ||
        portraitFlight ||
        state.cancelPending
      )
        return;
      if (!portraitIntent) {
        if (!entries.length || entries.some((entry) => !entry.stored || !entry.fileId)) {
          publish({ portraitMessage: "全部授权材料入库后才能提交" });
          return;
        }
        portraitIntent = {
          body: { fileIds: entries.map((entry) => entry.fileId!) },
          key: deps.key("asset_portrait_auth"),
        };
      }
      const intent = portraitIntent,
        own = generation,
        flight = {};
      portraitFlight = flight;
      publish({ portraitMessage: null, portraitPending: true });
      try {
        await deps.api.portrait(deps.id, intent.body, intent.key);
        if (!current(own)) return;
        portraitIntent = null;
        finishEntries();
        publish({ portraitPending: false, portraitMessage: "授权材料已补交，等待交付经理确认" });
        try {
          await deps.refresh();
        } catch {
          if (current(own))
            publish({
              portraitMessage: "授权材料已补交，等待交付经理确认；详情刷新失败，请重新刷新详情",
            });
        }
      } catch (error) {
        if (current(own)) {
          const pending = uncertain(error);
          if (!pending) portraitIntent = null;
          publish({ portraitPending: pending, portraitMessage: failure(error) });
        }
      } finally {
        if (portraitFlight === flight) portraitFlight = null;
        publish();
      }
    },
    cancel(): Promise<void> {
      if (!current() || selecting || portraitFlight || portraitIntent) return Promise.resolve();
      if (cancelling) return cancelling;
      const own = ++generation;
      entries.forEach((entry) => {
        const value = entry.job.snapshot();
        if (value.fileId) entry.fileId = value.fileId;
        entry.job.dispose();
      });
      const previous = uploading;
      const flight = {};
      cancelFlight = flight;
      const work: Promise<void> = (async () => {
        try {
          const native = await getPorts();
          await previous;
          if (!current(own)) return;
          for (const entry of entries) {
            if (entry.stored) continue;
            if (!entry.fileId) {
              const registration = await native.files.register({
                category: "portrait_auth",
                files: [
                  {
                    fileName: entry.file.name,
                    sizeBytes: String(entry.file.size),
                    clientToken: entry.token,
                  },
                ],
              });
              if (!current(own)) return;
              const registered = registration.items.find(
                (item) => item.clientToken === entry.token,
              );
              if (!registered) throw new Error("登记未确认");
              entry.fileId = registered.fileId;
            }
            try {
              const result = await native.files.cancel(entry.fileId, entry.cancelKey);
              if (!current(own)) return;
              if (result.status !== "expired") throw new Error("取消未确认");
            } catch (error) {
              if (!(error instanceof ApiError) || error.error !== "STATE_NOT_ALLOWED") throw error;
              const result = await native.files.get(entry.fileId);
              if (!current(own)) return;
              if (result.status !== "stored" && result.status !== "expired")
                throw new Error("入库中", { cause: error });
            }
            native.forget(entry.fileId);
          }
          if (!current(own)) return;
          finishEntries();
          publish({
            cancelPending: false,
            portraitMessage: "未完成的上传已取消，已上传材料会保留",
          });
        } catch {
          if (current(own))
            publish({
              cancelPending: true,
              portraitMessage: "取消结果未确认，请重试取消后再选择新材料",
            });
        } finally {
          if (cancelFlight === flight) {
            cancelFlight = null;
            cancelling = null;
          }
          publish();
        }
      })();
      cancelling = work;
      publish({ cancelPending: true });
      return work;
    },
    suspend() {
      visible = false;
      generation++;
      entries.forEach((entry) => entry.job.pause());
    },
    resume() {
      if (!base()) return;
      visible = true;
      const own = ++generation;
      publish();
      if (uploading) {
        const previous = uploading;
        entries.forEach((entry) => {
          if (entry.job.snapshot().status === "paused")
            void entry.job.retry().catch(() => undefined);
        });
        void previous.then(() => {
          if (current(own) && !state.cancelPending && !portraitIntent) return upload();
        });
      }
    },
    dispose() {
      alive = false;
      generation++;
      finishEntries();
      listeners.clear();
    },
  };
}
