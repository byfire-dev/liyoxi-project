import { ApiError } from "@/lib/request";
import type { UploadApi } from "@/lib/upload/api";
import type { SelectedFile, UploadJob } from "@/lib/upload/queue";
import type { ResumeOwner } from "@/lib/upload/resume";
import type { AssetUploadApi } from "./upload-api";
import type { AssetUploadRecords } from "./upload-records";
import {
  intentBody,
  validateUploadForm,
  type AssetUploadTask,
  type UploadForm,
  type UploadIntent,
} from "./upload-model";

export interface AssetTaskDeps {
  owner: ResumeOwner;
  scope(): string | null;
  records: AssetUploadRecords;
  api: Pick<AssetUploadApi, "create">;
  files: UploadApi;
  fingerprint(file: SelectedFile): Promise<string>;
  job(file: SelectedFile): UploadJob;
  forgetResume(fileId: string): void;
  key(action: string): string;
  now(): number;
}
interface Entry {
  view: AssetUploadTask;
  jobs: (UploadJob | null)[];
  removers: (() => void)[];
  generation: number;
  work: Promise<void> | null;
  cancelling: Promise<void> | null;
}
const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");
export function createAssetUploadTasks(deps: AssetTaskDeps) {
  const ownerScope = deps.scope();
  let alive = true,
    enqueuing = false;
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let snapshot: { tasks: AssetUploadTask[]; error: string | null } = { tasks: [], error: null };
  const stop = () => {
    if (!alive) return;
    alive = false;
    entries.forEach((entry) => {
      entry.generation++;
      entry.removers.forEach((remove) => remove());
      entry.jobs.forEach((job) => job?.dispose());
    });
    snapshot = { tasks: [], error: null };
    listeners.forEach((run) => run());
    listeners.clear();
  };
  const current = () => {
    if (alive && (ownerScope === null || deps.scope() !== ownerScope)) stop();
    return alive;
  };
  const publish = () => {
    if (!current()) return;
    snapshot = {
      ...snapshot,
      tasks: entries.map((entry) => ({
        ...entry.view,
        intent: JSON.parse(JSON.stringify(entry.view.intent)),
        files: entry.view.files.map((file) => ({ ...file })),
      })),
    };
    listeners.forEach((run) => run());
  };
  const entryFor = (intent: UploadIntent): Entry => ({
    view: {
      intent,
      phase:
        intent.phase === "uploading"
          ? "needs_reselect"
          : intent.phase === "cancelling" || intent.phase === "cancel_unknown"
            ? "cancel_failed"
            : "create_unknown",
      files: intent.files.map((file) => ({
        name: file.name,
        status: file.status === "stored" ? "stored" : "needs_reselect",
        progress: file.status === "stored" ? 100 : 0,
        message: null,
      })),
      message: null,
      result: null,
    },
    jobs: intent.files.map(() => null),
    removers: [],
    generation: 0,
    work: null,
    cancelling: null,
  });
  try {
    entries.push(...deps.records.list(deps.owner).map(entryFor));
  } catch (error) {
    snapshot = { ...snapshot, error: message(error) };
  }
  publish();
  const save = (entry: Entry) => {
    if (!current()) throw new Error("门店或成员已变化，原任务已停止");
    deps.records.save(entry.view.intent);
  };
  const blocked = (entry: Entry, error: unknown) => {
    entry.view = { ...entry.view, phase: "recovery_blocked", message: message(error) };
    entry.jobs.forEach((job) => job?.pause());
    publish();
  };
  const attach = (entry: Entry, index: number, file: SelectedFile) => {
    entry.removers[index]?.();
    entry.jobs[index]?.dispose();
    const job = deps.job(file);
    entry.jobs[index] = job;
    entry.removers[index] = job.subscribe(() => {
      if (!current() || entry.cancelling || entry.view.phase === "recovery_blocked") return;
      const state = job.snapshot();
      entry.view.files[index] = {
        name: file.name,
        status: state.status,
        progress: state.progress,
        message: state.message,
      };
      const record = entry.view.intent.files[index]!;
      if (state.fileId && record.fileId !== state.fileId) {
        record.fileId = state.fileId;
        try {
          save(entry);
        } catch (error) {
          blocked(entry, error);
          return;
        }
      }
      publish();
    });
  };
  const run = (entry: Entry): Promise<void> => {
    if (entry.work) return entry.work;
    if (
      !current() ||
      entry.cancelling ||
      [
        "cancelled",
        "succeeded",
        "recovery_blocked",
        "cancel_failed",
        "cancel_unknown",
        "cancelling",
      ].includes(entry.view.phase)
    )
      return Promise.resolve();
    const generation = entry.generation;
    const check = () => {
      if (!current() || generation !== entry.generation) throw new Error("原任务已停止");
    };
    const work = (async () => {
      try {
        check();
        if (entry.view.intent.expiresAt <= deps.now())
          throw new Error("原任务已过期，请确认取消后重新上传");
        entry.view = { ...entry.view, phase: "uploading", message: null };
        publish();
        for (const [index, record] of entry.view.intent.files.entries()) {
          check();
          if (record.status === "stored") {
            const status = await deps.files.get(record.fileId!);
            check();
            if (status.status !== "stored" || status.moderationState === "block")
              throw new Error("已上传文件不再可用，请保留任务并处理");
            continue;
          }
          const job = entry.jobs[index];
          if (!job && record.fileId && record.status === "pending") {
            const status = await deps.files.get(record.fileId);
            check();
            if (status.status === "stored" && status.moderationState !== "block") {
              record.status = "stored";
              entry.view.files[index] = {
                name: record.name,
                status: "stored",
                progress: 100,
                message: null,
              };
              save(entry);
              continue;
            }
          }
          if (!job || record.status === "cancelled") continue;
          const result = await job.start();
          check();
          if (entry.view.phase === "recovery_blocked") return;
          if (result) {
            if (result.status !== "stored" || result.moderationState === "block")
              throw new Error("文件尚未入库或已被拦截，不能创建素材");
            record.fileId = result.fileId;
            record.status = "stored";
            entry.view.files[index] = {
              name: record.name,
              status: "stored",
              progress: 100,
              message: null,
            };
            save(entry);
            entry.removers[index]?.();
            job.dispose();
            entry.jobs[index] = null;
          } else if (job.snapshot().recovery) {
            entry.view = {
              ...entry.view,
              phase: job.snapshot().recovery === "initiate_unknown" ? "recovery_blocked" : "failed",
              message: job.snapshot().message,
            };
            publish();
            return;
          }
        }
        check();
        if (entry.view.intent.files.some((file) => file.status !== "stored")) {
          entry.view = {
            ...entry.view,
            phase: entry.jobs.some(
              (job, index) => !job && entry.view.intent.files[index]?.status === "pending",
            )
              ? "needs_reselect"
              : "failed",
            message: "尚有文件未入库；已入库文件会保留，请重选或重试失败文件",
          };
          publish();
          return;
        }
        const body = intentBody(entry.view.intent);
        entry.view.intent.phase = "submitting";
        save(entry);
        entry.view = { ...entry.view, phase: "submitting", message: null };
        publish();
        let result: Awaited<ReturnType<AssetUploadApi["create"]>>;
        try {
          result = await deps.api.create(body, entry.view.intent.createKey);
          check();
        } catch (error) {
          check();
          entry.view.intent.phase = "create_unknown";
          save(entry);
          entry.view = {
            ...entry.view,
            phase: "create_unknown",
            message: `提交未确认，请用原意图重试：${message(error)}`,
          };
          publish();
          return;
        }
        entry.view = {
          ...entry.view,
          phase: "succeeded",
          result,
          message: "素材已提交，整理结果以素材详情为准",
        };
        try {
          deps.records.remove(deps.owner, entry.view.intent.id);
        } catch {
          entry.view.message = "素材已提交，本机记录清理失败；再次确认仍使用原意图";
        }
        publish();
      } catch (error) {
        if (current() && generation === entry.generation) {
          entry.view = {
            ...entry.view,
            phase: entry.view.phase === "submitting" ? "create_unknown" : "failed",
            message: message(error),
          };
          publish();
        }
      }
    })();
    entry.work = work;
    void work.finally(() => {
      if (entry.work === work) entry.work = null;
    });
    return work;
  };
  const find = (id: string) => entries.find((entry) => entry.view.intent.id === id);
  const cancel = (entry: Entry): Promise<void> => {
    if (entry.cancelling) return entry.cancelling;
    if (
      !current() ||
      ["submitting", "create_unknown", "succeeded", "cancelled"].includes(entry.view.phase)
    )
      return Promise.resolve();
    entry.generation++;
    entry.removers.forEach((remove) => remove());
    entry.jobs.forEach((job) => job?.dispose());
    entry.jobs = entry.jobs.map(() => null);
    const previous = entry.work;
    entry.view.intent.phase = "cancelling";
    entry.view = { ...entry.view, phase: "cancelling", message: null };
    publish();
    const work = (async () => {
      try {
        save(entry);
        await previous;
        if (!current()) return;
        for (const file of entry.view.intent.files) {
          if (file.status === "cancelled" && file.fileId) {
            try {
              deps.forgetResume(file.fileId);
            } catch (error) {
              blocked(entry, error);
              return;
            }
          }
          if (file.status !== "pending") continue;
          if (!file.fileId) {
            const response = await deps.files.register({
              category: "store_asset",
              files: [
                { fileName: file.name, sizeBytes: String(file.size), clientToken: file.token },
              ],
            });
            if (!current()) return;
            const registration = response.items[0];
            if (!registration || registration.clientToken !== file.token)
              throw new Error("原上传登记仍未确认，请重试取消");
            file.fileId = registration.fileId;
            save(entry);
          }
          try {
            const response = await deps.files.cancel(file.fileId, file.cancelKey);
            if (!current()) return;
            if (response.status !== "expired") throw new Error("服务端尚未确认取消");
          } catch (error) {
            if (!current()) return;
            if (error instanceof ApiError && error.error === "STATE_NOT_ALLOWED") {
              const status = await deps.files.get(file.fileId);
              if (!current()) return;
              if (status.status === "stored") {
                file.status = "stored";
                save(entry);
                continue;
              }
              if (status.status !== "expired")
                throw new Error("文件正在入库，暂不能取消；请稍后回查", { cause: error });
            } else throw error;
          }
          file.status = "cancelled";
          save(entry);
          try {
            deps.forgetResume(file.fileId);
          } catch (error) {
            blocked(entry, error);
            return;
          }
        }
        if (!current()) return;
        deps.records.remove(deps.owner, entry.view.intent.id);
        const stored = entry.view.intent.files.filter((file) => file.status === "stored").length;
        entry.view = {
          ...entry.view,
          phase: "cancelled",
          message: `未入库登记已确认取消${stored ? `；${stored}份已入库文件未删除，将按服务端保留规则处理` : ""}，可重新选择文件开始新意图`,
        };
        publish();
      } catch (error) {
        if (current()) {
          entry.view.intent.phase = "cancel_unknown";
          try {
            save(entry);
          } catch {
            /* 原意图保留，不能把存储失败当取消成功。 */
          }
          entry.view = {
            ...entry.view,
            phase: "cancel_failed",
            message: `取消未确认，禁止重新上传：${message(error)}`,
          };
          publish();
        }
      }
    })();
    entry.cancelling = work;
    void work.finally(() => {
      if (entry.cancelling === work) entry.cancelling = null;
    });
    return work;
  };
  return {
    snapshot: () => {
      current();
      return snapshot;
    },
    current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async enqueue(form: UploadForm): Promise<string | null> {
      if (!current() || snapshot.error || enqueuing) return null;
      enqueuing = true;
      try {
        validateUploadForm(form);
        const frozen = JSON.parse(JSON.stringify(form)) as UploadForm;
        const files: UploadIntent["files"] = [];
        for (const file of frozen.files) {
          const token = await deps.fingerprint(file);
          if (!current()) return null;
          if (
            files.some((item) => item.token === token) ||
            entries.some(
              (entry) =>
                !["succeeded", "cancelled"].includes(entry.view.phase) &&
                entry.view.intent.files.some((item) => item.token === token),
            )
          )
            throw new Error("同一文件已有待办任务，请先恢复或确认取消");
          files.push({
            name: file.name,
            size: file.size,
            width: file.width ?? 0,
            height: file.height ?? 0,
            durationMs: file.durationMs ?? 0,
            token,
            fileId: null,
            cancelKey: deps.key("file_cancel"),
            status: "pending",
          });
        }
        if (!current()) return null;
        const intent: UploadIntent = {
          version: 1,
          id: deps.key("asset_task"),
          owner: deps.owner,
          expiresAt: deps.now() + 86400000,
          createKey: deps.key("asset_create"),
          type: frozen.type,
          textBody: frozen.textBody,
          note: frozen.note,
          tags: frozen.tags,
          demandId: frozen.demandId,
          files,
          phase: "uploading",
        };
        deps.records.save(intent);
        const entry = entryFor(intent);
        entries.push(entry);
        entry.view.phase = "queued";
        frozen.files.forEach((file, index) => attach(entry, index, file));
        publish();
        void run(entry);
        return intent.id;
      } catch (error) {
        if (current()) {
          snapshot = { ...snapshot, error: message(error) };
          publish();
        }
        return null;
      } finally {
        enqueuing = false;
      }
    },
    clearError() {
      if (current()) {
        snapshot = { ...snapshot, error: null };
        publish();
      }
    },
    retry(id: string) {
      const entry = find(id);
      return entry ? run(entry) : Promise.resolve();
    },
    async reselect(id: string, index: number, file: SelectedFile): Promise<void> {
      const entry = find(id),
        record = entry?.view.intent.files[index];
      if (
        !entry ||
        !record ||
        !current() ||
        entry.cancelling ||
        record.status !== "pending" ||
        ["cancel_failed", "cancelling", "create_unknown", "submitting"].includes(entry.view.phase)
      )
        return;
      const generation = entry.generation;
      try {
        const token = await deps.fingerprint(file);
        if (!current() || generation !== entry.generation) return;
        if (file.size !== record.size || token !== record.token)
          throw new Error("重选文件与原上传不一致，请重选同一文件");
        if (entry.view.intent.expiresAt <= deps.now())
          throw new Error("原任务已过期，请确认取消后重新上传");
        entry.view.phase = "needs_reselect";
        entry.view.message = null;
        attach(entry, index, file);
        publish();
        await run(entry);
      } catch (error) {
        if (current() && generation === entry.generation) {
          entry.view = { ...entry.view, phase: "needs_reselect", message: message(error) };
          publish();
        }
      }
    },
    cancel(id: string) {
      const entry = find(id);
      return entry ? cancel(entry) : Promise.resolve();
    },
    forget(id: string) {
      const entry = find(id);
      if (current() && entry && ["cancelled", "succeeded"].includes(entry.view.phase)) {
        entries.splice(entries.indexOf(entry), 1);
        publish();
      }
    },
    dispose: stop,
  };
}
export type AssetUploadTasks = ReturnType<typeof createAssetUploadTasks>;
