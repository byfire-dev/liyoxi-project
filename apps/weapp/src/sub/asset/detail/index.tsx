import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Video, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import { InfoTag } from "@/components/InfoTag";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Section } from "@/components/Section";
import { Skeleton } from "@/components/Skeleton";
import { ProgressBar } from "@/components/ProgressBar";
import { StatusTag, merchantStatusByEnum, merchantStatusByState } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import { TextArea } from "@/components/TextArea";
import { Timeline } from "@/components/Timeline";
import { account, useAccount } from "@/lib/account-runtime";
import { ensurePrivacyAuthorized, newIdempotencyKey, request } from "@/lib/runtime";
import type { RequestLayer } from "@/lib/request";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import {
  assetLabels,
  assetModerationLabel,
  assetStatuses,
  assetTitle,
  createAssetApi,
} from "../private/api";
import { createAssetMedia, fileAvailable } from "../private/media";
import { assetScope, createAssetResource } from "../private/resource";
import { createAssetDetailApi } from "../private/detail-api";
import { createAssetDetailActions } from "../private/detail-actions";
import "./index.scss";

let offline: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const actionScene = (globalThis as { __LYX_ASSET_ACTION_SHOT__?: string })
      .__LYX_ASSET_ACTION_SHOT__;
    if (actionScene) {
      offline ??= (
        await import("../../../../shots/asset-action-fixtures")
      ).offlineAssetActionRequest(actionScene);
      return offline(path, options);
    }
    const scene = (globalThis as { __LYX_ASSET_SHOT__?: string }).__LYX_ASSET_SHOT__;
    if (scene) {
      offline ??= (await import("../../../../shots/asset-fixtures")).offlineAssetRequest(scene);
      return offline(path, options);
    }
  }
  return request(path, options);
};
const api = createAssetApi(call);
const scope = () =>
  assetScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );
export default function AssetDetailPage() {
  const { me } = useAccount();
  const token = useSessionStore((s) => s.accessToken),
    store = useContextStore();
  const id = Taro.getCurrentInstance().router?.params.storeAssetId;
  const key = assetScope(token, store, me);
  useEffect(() => {
    void account.start().catch(() => undefined);
  }, []);
  return key && id ? (
    <DetailContent key={`${key}:${id}`} id={id} />
  ) : (
    <PageBody>
      <Empty title={!id ? "缺少素材编号" : token ? "请选择当前成员门店" : "登录后查看素材"} />
    </PageBody>
  );
}
function DetailContent({ id }: { id: string }) {
  const ready = useRef(false);
  const [nativeVideo] = useState(() => ({
    context: null as ReturnType<typeof Taro.createVideoContext> | null,
  }));
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState<string | null>(null),
    [playing, setPlaying] = useState<string | null>(null);
  const [video, setVideo] = useState<{ url: string; fileId: string } | null>(null);
  const [resource] = useState(() => createAssetResource({ api, scope, id }));
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot);
  const [media] = useState(() =>
    createAssetMedia({
      scope,
      detail: () => resource.snapshot().detail,
      refresh: () => resource.refresh(),
      now: Date.now,
      publish: (value, file) => {
        setMessage(value);
        setPlaying(file);
      },
      ports: {
        privacy: ensurePrivacyAuthorized,
        image: (urls, current) => Taro.previewImage({ urls, current }),
        video: (url, fileId) => setVideo({ url, fileId }),
        stopVideo: () => {
          nativeVideo.context?.stop();
          nativeVideo.context = null;
          if (resource.current()) setVideo(null);
        },
        audio: () => Taro.createInnerAudioContext(),
        download: (url) => {
          const task = Taro.downloadFile({ url, timeout: 15000 });
          return { promise: Promise.resolve(task), abort: () => task.abort() };
        },
        document: (filePath) => Taro.openDocument({ filePath }),
        unlink: (filePath) => {
          Taro.getFileSystemManager?.().unlink({ filePath, fail: () => undefined });
        },
      },
    }),
  );
  const [actions] = useState(() =>
    createAssetDetailActions({
      id,
      scope,
      detail: () => resource.snapshot().detail,
      api: createAssetDetailApi(call),
      key: newIdempotencyKey,
      ports: async (current) => {
        if (process.env.TARO_ENV === "h5") {
          const scene = (globalThis as { __LYX_ASSET_ACTION_SHOT__?: string })
            .__LYX_ASSET_ACTION_SHOT__;
          if (scene)
            return (await import("../../../../shots/asset-action-fixtures")).assetActionPorts(
              scene,
              current,
            );
        }
        return (await import("../private/portrait-platform")).createNativePortraitPorts(current);
      },
      refresh: async () => {
        media.stop();
        await resource.refresh();
      },
    }),
  );
  const actionState = useSyncExternalStore(actions.subscribe, actions.snapshot, actions.snapshot);
  const load = useCallback(async () => {
    setNow(Date.now());
    media.stop();
    await resource.prepare(account.start);
  }, [media, resource]);
  useEffect(() => {
    void resource.prepare(account.start).finally(() => {
      if (resource.current()) {
        setNow(Date.now());
        ready.current = true;
      }
    });
    return () => {
      resource.dispose();
      media.dispose();
      actions.dispose();
    };
  }, [actions, media, resource]);
  useDidShow(() => {
    actions.resume();
    if (ready.current) void load();
  });
  useDidHide(() => {
    actions.suspend();
    media.stop();
    resource.suspend();
  });
  usePullDownRefresh(() => {
    void load().finally(() => {
      if (resource.current()) Taro.stopPullDownRefresh();
    });
  });
  const detail = state.detail;
  const membership = account
    .snapshot()
    .me?.memberships.find((item) =>
      item.stores.some((s) => s.storeId === useContextStore.getState().currentStoreId),
    );
  const label = detail ? assetStatuses[detail.displayStatus] : "";
  const status = merchantStatusByState("store-asset", label);
  const transcripts = detail?.fileTranscripts.length
    ? detail.fileTranscripts
    : detail?.transcript
      ? [{ ...detail.transcript, fileId: "" }]
      : [];
  return (
    <View className="asset-detail" id={!state.loading ? "asset-ready" : undefined}>
      <PageBody>
        {actionState.feedbackMessage ? (
          <Note className="asset-feedback-message">{actionState.feedbackMessage}</Note>
        ) : null}
        {actionState.portraitMessage ? (
          <Note className="asset-portrait-message">{actionState.portraitMessage}</Note>
        ) : null}
        {state.loading && !detail ? (
          <Skeleton cards={4} />
        ) : state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              void load();
            }}
          />
        ) : null}
        {detail ? (
          <>
            <View className="asset-detail__title">{assetTitle(detail)}</View>
            <StatusTag tone={status?.tone ?? "neutral"}>{label}</StatusTag>
            {detail.quote ? <Note>{detail.quote}</Note> : null}
            <View className="asset-detail__muted">
              {assetLabels[detail.type]} · {detail.fileCount}份 · 采用{detail.adoptedCount}次 ·{" "}
              {detail.createdAt}
            </View>
            <View className="asset-detail__muted">
              {detail.uploader.displayName ?? "上传人"} ·{" "}
              {detail.uploader.role === "owner"
                ? "老板"
                : detail.uploader.role === "clerk"
                  ? "店员"
                  : "服务人员"}
              {detail.uploader.isMe ? " · 我上传的" : ""}
            </View>
            <View className="asset-detail__tags">
              {detail.isSelectableAsReference ? <InfoTag>可作参考</InfoTag> : null}
              {detail.techSpecLabel ? <InfoTag>{detail.techSpecLabel}</InfoTag> : null}
              {detail.durationMs !== null ? (
                <InfoTag>{Math.ceil(detail.durationMs / 1000)}秒</InfoTag>
              ) : null}
              {detail.pageCount !== null ? <InfoTag>{detail.pageCount}页</InfoTag> : null}
              {detail.structuredItemCount !== null ? (
                <InfoTag>{detail.structuredItemCount}项</InfoTag>
              ) : null}
            </View>
            <Note className="asset-detail__moderation">
              {merchantStatusByEnum("store_asset.processing_state", detail.processingState)
                ?.label ?? "整理状态待确认"}{" "}
              · {detail.reviewState === "reviewed" ? "已复核" : "未复核"} ·{" "}
              {assetModerationLabel(detail.moderationState)}
            </Note>
            {detail.isInsightPartial ? (
              <Note tone="warning">部分内容尚未完成整理，请按原始素材核对</Note>
            ) : null}
            <TextButton
              onClick={() => {
                void load();
              }}
            >
              刷新整理结果与文件
            </TextButton>
            {message ? <Note tone="warning">{message}</Note> : null}
            <Section title="原始内容">
              <Card>
                {detail.textBody ? (
                  <View className="asset-detail__text">{detail.textBody}</View>
                ) : null}
                {detail.note ? (
                  <View className="asset-detail__text">说明：{detail.note}</View>
                ) : null}
                {!detail.textBody && !detail.note && !detail.files.length ? (
                  <Empty title="暂无原始内容" />
                ) : null}
                {detail.files.map((file, n) => (
                  <View key={file.fileId} className="asset-detail__file">
                    <View>
                      文件 {n + 1} ·{" "}
                      {file.kind === "image"
                        ? "图片"
                        : file.kind === "video"
                          ? "视频"
                          : file.kind === "audio"
                            ? "音频"
                            : file.kind === "document"
                              ? "文档"
                              : "文件"}
                      {file.displayWidth && file.displayHeight
                        ? ` · ${file.displayWidth}×${file.displayHeight}`
                        : ""}
                      {file.durationMs !== null ? ` · ${Math.ceil(file.durationMs / 1000)}秒` : ""}
                    </View>
                    <View className="asset-detail__muted">
                      {assetModerationLabel(file.moderationState)}
                      {!fileAvailable(file, now) ? " · 需重新获取文件" : ""}
                    </View>
                    {["image", "video", "audio", "document"].includes(file.kind) ? (
                      <TextButton
                        onClick={() => {
                          void media.open(file.fileId);
                        }}
                      >
                        {playing === file.fileId
                          ? "暂停"
                          : file.kind === "video"
                            ? "播放视频"
                            : file.kind === "audio"
                              ? "播放音频"
                              : "预览文件"}
                      </TextButton>
                    ) : null}
                    {["image", "video", "audio", "document"].includes(file.kind) ? (
                      <TextButton
                        onClick={() => {
                          void media.open(file.fileId, true);
                        }}
                      >
                        重新获取文件
                      </TextButton>
                    ) : null}
                    {video?.fileId === file.fileId &&
                    file.url === video.url &&
                    fileAvailable(file, now) ? (
                      <Video
                        id="asset-video"
                        className="asset-detail__video"
                        src={video.url}
                        controls
                        autoplay={false}
                        onPlay={() => {
                          nativeVideo.context = Taro.createVideoContext("asset-video");
                          if (!media.current() || !fileAvailable(file, Date.now())) media.stop();
                        }}
                        onError={() => {
                          media.stop();
                          if (resource.current()) setMessage("视频暂时无法播放，请重新获取文件");
                        }}
                      />
                    ) : null}
                  </View>
                ))}
              </Card>
            </Section>
            <Section title="转写">
              <Card>
                {transcripts.length ? (
                  transcripts.map((transcript, n) => (
                    <View key={transcript.fileId || "combined"}>
                      <View className="asset-detail__muted">
                        {transcript.fileId
                          ? `文件 ${detail.files.findIndex((f) => f.fileId === transcript.fileId) + 1} 转写`
                          : "转写全文"}
                      </View>
                      <View className="asset-detail__text">
                        {transcript.text || "暂无转写内容"}
                      </View>
                      {transcript.segments.map((segment, i) => (
                        <View key={`${n}:${i}`} className="asset-detail__muted">
                          {Math.floor(segment.fromMs / 1000)}–{Math.ceil(segment.toMs / 1000)}秒 ·{" "}
                          {segment.text}
                        </View>
                      ))}
                    </View>
                  ))
                ) : (
                  <Empty title="暂无转写" />
                )}
              </Card>
            </Section>
            <Section title="整理要点">
              <Card>
                {detail.highlights.length ? (
                  detail.highlights.map((point, n) => (
                    <View key={n} className="asset-detail__text">
                      {n + 1}. {point}
                    </View>
                  ))
                ) : (
                  <Empty title="暂无整理要点" />
                )}
                {detail.structuredItems.map((item, n) => (
                  <View key={n}>
                    {item.name}
                    {item.priceText ? ` · ${item.priceText}` : ""}
                  </View>
                ))}
              </Card>
            </Section>
            <Section title="标签">
              <Card>
                {(["content", "usage", "timeliness"] as const).map((dimension) => (
                  <View key={dimension}>
                    <View>
                      {dimension === "content" ? "内容" : dimension === "usage" ? "用途" : "时效"}
                    </View>
                    <View className="asset-detail__tags">
                      {detail.tagsByDimension[dimension].map((tag) => (
                        <InfoTag key={tag.tag.code}>
                          {tag.tag.name} · {tag.isConfirmed ? "已确认" : "待确认"}
                          {tag.validStartDate ? ` · ${tag.validStartDate}起` : ""}
                          {tag.validEndDate ? ` · 至${tag.validEndDate}` : ""}
                        </InfoTag>
                      ))}
                    </View>
                  </View>
                ))}
              </Card>
              {detail.actions.includes("feedback") ? (
                <View className="asset-feedback">
                  <TextButton onClick={actions.openFeedback}>标签有误？去反馈</TextButton>
                  {actionState.feedbackOpen ? (
                    <Card>
                      <View className="asset-detail__muted">
                        反馈将交由交付经理核对，不会直接修改标签
                      </View>
                      <View className="asset-detail__tags">
                        {([undefined, "content", "usage", "timeliness", "usability"] as const).map(
                          (dimension) => (
                            <Chip
                              key={dimension ?? "all"}
                              selected={actionState.dimension === dimension}
                              disabled={actionState.feedbackBusy || actionState.feedbackPending}
                              onClick={() => actions.editFeedback(actionState.content, dimension)}
                            >
                              {dimension === undefined
                                ? "不指定维度"
                                : {
                                    content: "内容",
                                    usage: "用途",
                                    timeliness: "时效",
                                    usability: "可用性",
                                  }[dimension]}
                            </Chip>
                          ),
                        )}
                      </View>
                      <TextArea
                        value={actionState.content}
                        maxLength={200}
                        disabled={actionState.feedbackBusy || actionState.feedbackPending}
                        placeholder="请描述标签或内容哪里有误，最多200字"
                        onChange={(value) => actions.editFeedback(value, actionState.dimension)}
                      />
                      <Button
                        block
                        variant="secondary"
                        loading={actionState.feedbackBusy}
                        disabled={!actionState.content.trim()}
                        onClick={() => {
                          void actions.feedback();
                        }}
                      >
                        {actionState.feedbackPending ? "重试确认反馈" : "提交反馈"}
                      </Button>
                    </Card>
                  ) : null}
                </View>
              ) : null}
            </Section>
            <Section title="复核与授权">
              <Card>
                <View>复核人：{detail.reviewedBy?.displayName ?? "尚未复核"}</View>
                <View className="asset-detail__muted">{detail.reviewedAt ?? "暂无复核时间"}</View>
                <View>
                  肖像授权材料 {detail.portraitAuth.fileCount} 份 ·{" "}
                  {detail.portraitAuth.authorizedAt ?? "尚未确认"}
                </View>
                {detail.assetDemand ? <View>素材需求：{detail.assetDemand.title}</View> : null}
              </Card>
              {detail.actions.includes("portrait-auth") ? (
                <View className="asset-portrait">
                  <TextButton onClick={actions.openPortrait}>添加授权材料</TextButton>
                  {actionState.portraitOpen ? (
                    <Card>
                      <Note>
                        每次1–9份JPG、PNG或PDF。补交后仍需交付经理确认，材料不在商家端签发预览。
                      </Note>
                      <View className="asset-detail__tags">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            actionState.portraitBusy ||
                            actionState.portraitPending ||
                            actionState.cancelPending ||
                            actionState.files.length >= 9
                          }
                          onClick={() => {
                            void actions.choose("image");
                          }}
                        >
                          选择授权图片
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            actionState.portraitBusy ||
                            actionState.portraitPending ||
                            actionState.cancelPending ||
                            actionState.files.length >= 9
                          }
                          onClick={() => {
                            void actions.choose("pdf");
                          }}
                        >
                          选择PDF授权材料
                        </Button>
                      </View>
                      {actionState.files.map((file) => (
                        <View className="asset-detail__file" key={file.key}>
                          <View>{file.name}</View>
                          <View className="asset-detail__muted">
                            {(
                              {
                                queued: "等待上传",
                                uploading: "上传中",
                                confirming: "确认传输",
                                storing: "入库中",
                                stored: "已入库",
                                failed: "上传未完成",
                                paused: "已暂停",
                                cancelled: "已停止",
                              } as Record<string, string>
                            )[file.status] ?? "待核对"}
                          </View>
                          <ProgressBar percent={file.progress} />
                          {file.message ? <Note>{file.message}</Note> : null}
                        </View>
                      ))}
                      {actionState.files.some((file) => file.status !== "stored") &&
                      !actionState.portraitPending &&
                      !actionState.cancelPending ? (
                        <Button
                          block
                          variant="secondary"
                          loading={actionState.portraitBusy}
                          onClick={() => {
                            void actions.upload();
                          }}
                        >
                          重试未完成上传
                        </Button>
                      ) : null}
                      <Button
                        block
                        loading={actionState.portraitBusy}
                        disabled={
                          actionState.cancelPending ||
                          !actionState.files.length ||
                          actionState.files.some((file) => file.status !== "stored")
                        }
                        onClick={() => {
                          void actions.portrait();
                        }}
                      >
                        {actionState.portraitPending ? "重试确认授权提交" : "提交授权材料"}
                      </Button>
                      {actionState.files.length ? (
                        <Button
                          block
                          variant="secondary"
                          disabled={
                            actionState.portraitPending ||
                            (actionState.cancelPending && actionState.portraitBusy)
                          }
                          onClick={() => {
                            void actions.cancel();
                          }}
                        >
                          {actionState.cancelPending ? "重试确认取消" : "取消本次材料上传"}
                        </Button>
                      ) : null}
                      <Note>离开页面会停止本页未完成上传；已入库材料按服务端保留规则处理。</Note>
                    </Card>
                  ) : null}
                </View>
              ) : null}
            </Section>
            <Section title="使用记录">
              <Card>
                <Timeline
                  variant="record"
                  items={detail.timeline.map((item, n) => ({
                    key: `${item.kind}:${item.at}:${n}`,
                    title: {
                      uploaded: "上传",
                      processed: "整理",
                      reviewed: "复核",
                      used_as_reference: "用作参考",
                      adopted: "采用",
                    }[item.kind],
                    description: `${item.actorName ?? ""}${item.usedBy ? ` · ${item.usedBy.no}` : ""}`,
                    time: item.at,
                  }))}
                />
                {detail.timeline.map((item, n) =>
                  membership?.role === "owner" && item.usedBy?.type === "drama_order" ? (
                    <TextButton
                      key={n}
                      onClick={() => {
                        if (resource.current() && item.usedBy?.type === "drama_order")
                          void Taro.navigateTo({
                            url: `/sub/order/order-detail/index?dramaOrderId=${encodeURIComponent(item.usedBy.id)}`,
                          });
                      }}
                    >
                      查看订单 {item.usedBy.no}
                    </TextButton>
                  ) : null,
                )}
              </Card>
            </Section>
          </>
        ) : null}
      </PageBody>
    </View>
  );
}
