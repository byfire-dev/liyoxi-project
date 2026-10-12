import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "@tarojs/components";
import Taro, { useDidHide } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { ProgressBar } from "@/components/ProgressBar";
import { Skeleton } from "@/components/Skeleton";
import { merchantStatusByEnum } from "@/components/StatusTag";
import { Tabs } from "@/components/Tabs";
import { TextArea } from "@/components/TextArea";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import { withSubscribe } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { assetScope } from "../private/resource";
import { assetStatuses } from "../private/api";
import type { DemandPage, UploadTags } from "../private/upload-api";
import {
  uploadTypes,
  type AssetUploadTask,
  type UploadForm,
  type UploadType,
} from "../private/upload-model";
import { getAssetUploadRuntime, type AssetUploadRuntime } from "../private/upload-runtime";
import "./index.scss";

const labels: Record<UploadType, string> = {
  image: "图片",
  video: "视频",
  recording: "录音",
  audio: "音频",
  document: "文档",
  text: "文字",
};
const hints: Record<UploadType, string> = {
  image: "JPG、JPEG、PNG，最多9张",
  video: "MP4、MOV，最多9份",
  recording: "最长5分钟，录制后可试听",
  audio: "MP3、M4A、WAV、AAC，最多9份",
  document: "PDF、DOCX、TXT，最多9份",
  text: "填写1–500字，不附文件或补充说明",
};
const phases: Record<AssetUploadTask["phase"], string> = {
  queued: "等待上传",
  uploading: "上传中",
  submitting: "提交中",
  create_unknown: "提交待确认",
  cancelling: "取消中",
  cancel_unknown: "取消待确认",
  failed: "部分未完成",
  needs_reselect: "需要重选文件",
  recovery_blocked: "恢复已阻止",
  cancel_failed: "取消未确认",
  cancelled: "已取消",
  succeeded: "已提交",
};
const fileStatuses: Record<string, string> = {
  queued: "等待上传",
  uploading: "传输中",
  confirming: "确认传输",
  storing: "入库中",
  stored: "已入库",
  failed: "上传失败",
  paused: "已暂停",
  cancelled: "已取消",
  needs_reselect: "待重选",
};
const blank = (type: UploadType): UploadForm => ({
  type,
  files: [],
  textBody: "",
  note: "",
  tags: [],
  demandId: null,
});
const scope = () =>
  assetScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );
const explain = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");
export default function AssetUpload() {
  const { me } = useAccount(),
    token = useSessionStore((s) => s.accessToken),
    context = useContextStore();
  const key = assetScope(token, context, me);
  useEffect(() => {
    void account.start().catch(() => undefined);
  }, []);
  return key ? (
    <UploadLoader key={key} ownerScope={key} />
  ) : (
    <PageBody>
      <Empty title={token ? "请选择当前成员门店" : "登录后上传素材"} />
    </PageBody>
  );
}
function UploadLoader({ ownerScope }: { ownerScope: string }) {
  const [runtime, setRuntime] = useState<AssetUploadRuntime | null>(null),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void getAssetUploadRuntime()
      .then((value) => {
        if (alive && scope() === ownerScope) setRuntime(value);
      })
      .catch((reason: unknown) => {
        if (alive && scope() === ownerScope) setError(explain(reason));
      });
    return () => {
      alive = false;
    };
  }, [ownerScope, attempt]);
  return runtime ? (
    <UploadContent runtime={runtime} ownerScope={ownerScope} />
  ) : (
    <PageBody>
      {error ? (
        <LoadError
          message={error}
          onRetry={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        />
      ) : (
        <Skeleton />
      )}
    </PageBody>
  );
}
function UploadContent({
  runtime,
  ownerScope,
}: {
  runtime: AssetUploadRuntime;
  ownerScope: string;
}) {
  const [life] = useState(() => {
    let alive = true;
    return {
      current: () => alive,
      start: () => {
        alive = true;
      },
      stop: () => {
        alive = false;
      },
    };
  });
  const busy = useRef(false),
    optionFlight = useRef(false),
    optionMore = useRef(false);
  const current = () => life.current() && scope() === ownerScope && runtime.tasks.current();
  const [platform] = useState(() => runtime.platform(current));
  const tasks = useSyncExternalStore(
    runtime.tasks.subscribe,
    runtime.tasks.snapshot,
    runtime.tasks.snapshot,
  );
  const media = useSyncExternalStore(platform.subscribe, platform.snapshot, platform.snapshot);
  const [form, setForm] = useState(() => blank("image")),
    [submitting, setSubmitting] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [tags, setTags] = useState<UploadTags>([]),
    [demands, setDemands] = useState<DemandPage | null>(null),
    [loading, setLoading] = useState(true),
    [optionsError, setOptionsError] = useState<string | null>(null);
  const membership = account
    .snapshot()
    .me?.memberships.find((m) =>
      m.stores.some((s) => s.storeId === useContextStore.getState().currentStoreId),
    );
  const loadOptions = async (more = false) => {
    if (!current() || optionFlight.current || (more && (!demands?.hasMore || !demands.nextCursor)))
      return;
    optionFlight.current = true;
    optionMore.current = more;
    setLoading(true);
    setOptionsError(null);
    try {
      const page = await runtime.api.demands(more ? demands!.nextCursor! : undefined);
      if (!current()) return;
      if (more)
        setDemands((old) => {
          const ids = new Set(old?.items.map((d) => d.assetDemandId));
          return {
            ...page,
            items: [
              ...(old?.items ?? []),
              ...page.items.filter((d) => !ids.has(d.assetDemandId) && !!ids.add(d.assetDemandId)),
            ],
          };
        });
      else {
        setDemands(page);
        const values = await runtime.api.tags();
        if (current()) setTags(values);
      }
    } catch (error) {
      if (current()) setOptionsError(explain(error));
    } finally {
      optionFlight.current = false;
      if (current()) setLoading(false);
    }
  };
  const [initialLoad] = useState(() => loadOptions);
  useEffect(() => {
    life.start();
    void Promise.resolve().then(() => initialLoad());
    return () => {
      life.stop();
      platform.dispose();
    };
  }, [platform, initialLoad, life]);
  useDidHide(() => platform.reset());
  const choose = async (reselect?: { task: AssetUploadTask; index: number }) => {
    if (!current() || busy.current) return;
    busy.current = true;
    setMessage(null);
    try {
      const type = reselect?.task.intent.type ?? form.type;
      const files = await platform.choose(type, reselect ? 1 : 9 - form.files.length, !!reselect);
      if (!current()) return;
      if (reselect) {
        if (files[0])
          await runtime.tasks.reselect(reselect.task.intent.id, reselect.index, files[0]);
      } else setForm((old) => ({ ...old, files: [...old.files, ...files].slice(0, 9) }));
    } catch (error) {
      if (current()) setMessage(explain(error));
    } finally {
      busy.current = false;
    }
  };
  const submit = () => {
    if (!current() || busy.current || media.recording) return;
    busy.current = true;
    setSubmitting(true);
    setMessage(null);
    platform.reset();
    const execute = () => {
      void runtime.tasks
        .enqueue(form)
        .then((id) => {
          if (current() && id) setForm(blank(form.type));
        })
        .finally(() => {
          busy.current = false;
          if (current()) setSubmitting(false);
        });
    };
    if (membership?.role === "clerk") withSubscribe("asset_upload", execute)();
    else execute();
  };
  const record = () => {
    void platform.record().then((file) => {
      if (current() && file) setForm((old) => ({ ...old, files: [file] }));
    });
  };
  return (
    <View className="asset-upload" id={!loading ? "asset-upload-ready" : undefined}>
      <Tabs
        items={uploadTypes.map((type) => ({ key: type, label: labels[type] }))}
        value={form.type}
        onChange={(type) => {
          if (busy.current) return;
          platform.reset();
          setMessage(null);
          setForm(blank(type));
        }}
      />
      <PageBody>
        <Note>
          当前门店 · {membership?.role === "clerk" ? "店员" : "老板"}
          上传。离开本页后，当前成员的上传任务仍保留。
        </Note>
        <Card title={`上传${labels[form.type]}`}>
          <View className="asset-upload__muted">{hints[form.type]}</View>
          {form.type === "text" ? (
            <TextArea
              className="asset-upload__text"
              value={form.textBody}
              maxLength={500}
              placeholder="请填写要分享的故事或素材内容"
              onChange={(textBody) => setForm((old) => ({ ...old, textBody }))}
            />
          ) : (
            <>
              {form.files.map((file, index) => (
                <View className="asset-upload__file" key={`${file.path}:${index}`}>
                  <Text>{file.name}</Text>
                  <View className="asset-upload__muted">
                    {file.size} 字节
                    {file.durationMs ? ` · ${Math.round(file.durationMs / 1000)}秒` : ""}
                  </View>
                  <View className="asset-upload__actions">
                    <TextButton
                      onClick={() =>
                        setForm((old) => ({
                          ...old,
                          files: old.files.filter((_, n) => n !== index),
                        }))
                      }
                    >
                      移除文件
                    </TextButton>
                    {form.type === "audio" || form.type === "recording" ? (
                      <TextButton onClick={() => platform.listen(file)}>
                        {media.listening ? "停止试听" : "试听"}
                      </TextButton>
                    ) : null}
                  </View>
                </View>
              ))}
              {form.type === "recording" ? (
                <Button
                  variant="outline"
                  onClick={media.recording ? platform.stopRecording : record}
                >
                  {media.recording ? "停止录音" : "开始录音"}
                </Button>
              ) : (
                <Button
                  className="asset-upload__choose"
                  variant="outline"
                  disabled={form.files.length >= 9 || submitting}
                  onClick={() => {
                    void choose();
                  }}
                >
                  选择{labels[form.type]}
                </Button>
              )}
              <View className="asset-upload__muted">补充说明（选填）</View>
              <TextArea
                className="asset-upload__note"
                value={form.note}
                maxLength={200}
                placeholder="如：店里的招牌菜、值得讲述的经历"
                onChange={(note) => setForm((old) => ({ ...old, note }))}
              />
            </>
          )}
          <View className="asset-upload__muted">内容标签（最多8个）</View>
          <View className="asset-upload__chips asset-upload__tags">
            {tags.map((tag) => (
              <Chip
                key={tag.code}
                selected={form.tags.includes(tag.code)}
                disabled={!form.tags.includes(tag.code) && form.tags.length >= 8}
                onClick={() =>
                  setForm((old) => ({
                    ...old,
                    tags: old.tags.includes(tag.code)
                      ? old.tags.filter((t) => t !== tag.code)
                      : [...old.tags, tag.code],
                  }))
                }
              >
                {tag.name}
              </Chip>
            ))}
          </View>
          <View className="asset-upload__muted">关联素材需求（选填）</View>
          <View className="asset-upload__chips asset-upload__demands">
            <Chip
              selected={!form.demandId}
              onClick={() => setForm((old) => ({ ...old, demandId: null }))}
            >
              不关联
            </Chip>
            {demands?.items.map((demand) => (
              <Chip
                key={demand.assetDemandId}
                selected={form.demandId === demand.assetDemandId}
                onClick={() => setForm((old) => ({ ...old, demandId: demand.assetDemandId }))}
              >
                {demand.title}
              </Chip>
            ))}
          </View>
          {demands?.items
            .filter((d) => d.assetDemandId === form.demandId)
            .map((d) => (
              <Note key={d.assetDemandId}>
                {d.shootingNote ?? "按需求提供素材"} · {d.createdByName} · 截止{d.dueDate}
              </Note>
            ))}
          {loading ? (
            <Skeleton cards={1} rows={1} />
          ) : optionsError ? (
            <LoadError
              message={optionsError}
              onRetry={() => {
                void loadOptions(optionMore.current);
              }}
            />
          ) : demands?.hasMore ? (
            <TextButton
              onClick={() => {
                void loadOptions(true);
              }}
            >
              更多素材需求
            </TextButton>
          ) : null}
          {message || media.message ? <Note tone="warning">{message ?? media.message}</Note> : null}
          {tasks.error ? (
            <Note tone="danger">
              {tasks.error}
              <TextButton onClick={runtime.tasks.clearError}>重新检查</TextButton>
            </Note>
          ) : null}
          <Button
            className="asset-upload__submit"
            block
            loading={submitting}
            disabled={media.recording || !!tasks.error}
            onClick={submit}
          >
            提交素材
          </Button>
        </Card>
        <View className="asset-upload__tasks">
          <View className="asset-upload__muted">当前成员上传任务 · {tasks.tasks.length}</View>
          {tasks.tasks.map((task) => (
            <Card
              className="asset-upload__task"
              key={task.intent.id}
              title={`${labels[task.intent.type]} · ${phases[task.phase]}`}
            >
              {task.files.map((file, index) => (
                <View className="asset-upload__file" key={index}>
                  <Text>{file.name}</Text>
                  <View className="asset-upload__muted">
                    {fileStatuses[file.status] ?? "状态待确认"} · {file.progress}%
                  </View>
                  <ProgressBar percent={file.progress} />
                  {file.message ? <Note tone="warning">{file.message}</Note> : null}
                  {task.intent.files[index]?.status === "pending" &&
                  ["needs_reselect", "failed"].includes(task.phase) ? (
                    <TextButton
                      onClick={() => {
                        void choose({ task, index });
                      }}
                    >
                      重选同一文件
                    </TextButton>
                  ) : null}
                </View>
              ))}
              {task.result ? (
                <Note>
                  提交回执：{assetStatuses[task.result.displayStatus]} ·{" "}
                  {merchantStatusByEnum("store_asset.processing_state", task.result.processingState)
                    ?.label ?? "整理状态待确认"}
                </Note>
              ) : null}
              {task.message ? (
                <Note tone={task.phase === "succeeded" ? "success" : "warning"}>
                  {task.message}
                </Note>
              ) : null}
              {task.phase === "needs_reselect" ? (
                <Note>
                  临时文件不保证跨重启有效。请重选完整相同文件；完整分块摘要和远端进度仍须核对。
                </Note>
              ) : null}
              <View className="asset-upload__actions">
                {["failed", "needs_reselect", "create_unknown"].includes(task.phase) ? (
                  <TextButton
                    onClick={() => {
                      void runtime.tasks.retry(task.intent.id);
                    }}
                  >
                    {task.phase === "create_unknown" ? "用原意图确认提交" : "重试未完成任务"}
                  </TextButton>
                ) : null}
                {!["submitting", "create_unknown", "succeeded", "cancelled", "cancelling"].includes(
                  task.phase,
                ) ? (
                  <TextButton
                    onClick={() => {
                      void runtime.tasks.cancel(task.intent.id);
                    }}
                  >
                    {task.phase === "cancel_failed" ? "重试确认取消" : "确认取消未入库文件"}
                  </TextButton>
                ) : null}
                {task.result ? (
                  <TextButton
                    onClick={() => {
                      void Taro.navigateTo({
                        url: `/sub/asset/detail/index?storeAssetId=${encodeURIComponent(task.result!.storeAssetId)}`,
                      });
                    }}
                  >
                    查看素材详情
                  </TextButton>
                ) : null}
                {["succeeded", "cancelled"].includes(task.phase) ? (
                  <TextButton onClick={() => runtime.tasks.forget(task.intent.id)}>
                    移除任务卡片
                  </TextButton>
                ) : null}
              </View>
            </Card>
          ))}
        </View>
      </PageBody>
    </View>
  );
}
