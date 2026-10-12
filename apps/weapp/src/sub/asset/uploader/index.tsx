import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { ProgressBar } from "@/components/ProgressBar";
import { Skeleton } from "@/components/Skeleton";
import { merchantStatusByEnum } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { assetStatuses } from "../private/api";
import { assetScope } from "../private/resource";
import type { AssetUploadTask, UploadType } from "../private/upload-model";
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
const scope = () =>
  assetScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );
const explain = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");

export default function AssetUploader() {
  const { me } = useAccount(),
    token = useSessionStore((s) => s.accessToken),
    context = useContextStore();
  const key = assetScope(token, context, me);
  const member = me?.memberships.find((m) =>
    m.stores.some((s) => s.storeId === context.currentStoreId),
  );
  const store = member?.stores.find((s) => s.storeId === context.currentStoreId);
  useEffect(() => {
    void account.start().catch(() => undefined);
  }, []);
  return key ? (
    <UploaderLoader
      key={key}
      ownerScope={key}
      caption={`${store?.name ?? "当前门店"} · ${me?.user.displayName ?? "当前成员"}（${member?.role === "clerk" ? "店员" : "老板"}）`}
    />
  ) : (
    <PageBody>
      <Empty title={token ? "请选择当前成员门店" : "登录后查看上传任务"} />
    </PageBody>
  );
}
function UploaderLoader({ ownerScope, caption }: { ownerScope: string; caption: string }) {
  const [runtime, setRuntime] = useState<AssetUploadRuntime | null>(null);
  const [error, setError] = useState<string | null>(null),
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
    <UploaderContent runtime={runtime} ownerScope={ownerScope} caption={caption} />
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
function UploaderContent({
  runtime,
  ownerScope,
  caption,
}: {
  runtime: AssetUploadRuntime;
  ownerScope: string;
  caption: string;
}) {
  const selecting = useRef(false);
  const [life] = useState(() => {
    let alive = true,
      visible = true;
    return {
      current: () => alive && visible,
      start: () => {
        alive = true;
      },
      stop: () => {
        alive = false;
      },
      show: () => {
        visible = true;
      },
      hide: () => {
        visible = false;
      },
    };
  });
  const current = () => life.current() && scope() === ownerScope && runtime.tasks.current();
  const [platform] = useState(() => runtime.platform(current));
  const [message, setMessage] = useState<string | null>(null);
  const tasks = useSyncExternalStore(
    runtime.tasks.subscribe,
    runtime.tasks.snapshot,
    runtime.tasks.snapshot,
  );
  useEffect(() => {
    life.start();
    return () => {
      life.stop();
      platform.dispose();
    };
  }, [platform, life]);
  useDidShow(() => {
    life.show();
  });
  useDidHide(() => {
    life.hide();
    platform.reset();
  });
  const reselect = async (task: AssetUploadTask, index: number) => {
    if (!current() || selecting.current) return;
    selecting.current = true;
    setMessage(null);
    try {
      const files = await platform.choose(task.intent.type, 1, true);
      if (current() && files[0]) await runtime.tasks.reselect(task.intent.id, index, files[0]);
    } catch (error) {
      if (current()) setMessage(explain(error));
    } finally {
      selecting.current = false;
    }
  };
  return (
    <View className="asset-uploader" id="asset-uploader-ready">
      <PageBody>
        <Note>{caption}的上传任务。离开页面后继续由当前成员的上传队列持有。</Note>
        <Button
          variant="outline"
          onClick={() => {
            void Taro.navigateTo({ url: "/sub/asset/upload/index" });
          }}
        >
          上传新素材
        </Button>
        {tasks.error ? (
          <Note tone="danger">
            {tasks.error}
            <TextButton onClick={runtime.tasks.clearError}>重新检查</TextButton>
          </Note>
        ) : null}
        {message ? <Note tone="warning">{message}</Note> : null}
        {!tasks.tasks.length ? <Empty title="暂无上传任务" /> : null}
        <View className="asset-uploader__muted">当前成员任务 · {tasks.tasks.length}</View>
        {tasks.tasks.map((task) => (
          <Card
            className="asset-uploader__task"
            key={task.intent.id}
            title={`${labels[task.intent.type]} · ${phases[task.phase]}`}
          >
            {task.files.map((file, index) => (
              <View className="asset-uploader__file" key={index}>
                <Text>{file.name}</Text>
                <View className="asset-uploader__muted">
                  {fileStatuses[file.status] ?? "状态待确认"} · {file.progress}%
                </View>
                <ProgressBar percent={file.progress} />
                {file.message ? <Note tone="warning">{file.message}</Note> : null}
                {task.intent.files[index]?.status === "pending" &&
                ["needs_reselect", "failed"].includes(task.phase) ? (
                  <TextButton
                    onClick={() => {
                      void reselect(task, index);
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
              <Note tone={task.phase === "succeeded" ? "success" : "warning"}>{task.message}</Note>
            ) : null}
            {task.phase === "needs_reselect" ? (
              <Note>
                临时文件不保证跨重启有效。请重选完整相同文件，再核对完整分块摘要和远端进度。
              </Note>
            ) : null}
            <View className="asset-uploader__actions">
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
                  {["cancel_failed", "cancel_unknown"].includes(task.phase)
                    ? "重试确认取消"
                    : "确认取消未入库文件"}
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
      </PageBody>
    </View>
  );
}
