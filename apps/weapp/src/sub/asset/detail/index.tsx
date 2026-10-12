import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Video, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { InfoTag } from "@/components/InfoTag";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Section } from "@/components/Section";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum, merchantStatusByState } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import { Timeline } from "@/components/Timeline";
import { account, useAccount } from "@/lib/account-runtime";
import { ensurePrivacyAuthorized, request } from "@/lib/runtime";
import type { RequestLayer } from "@/lib/request";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { assetLabels, assetStatuses, assetTitle, createAssetApi } from "../private/api";
import { createAssetMedia, fileAvailable } from "../private/media";
import { assetScope, createAssetResource } from "../private/resource";
import "./index.scss";

let offline: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
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
    };
  }, [media, resource]);
  useDidShow(() => {
    if (ready.current) void load();
  });
  useDidHide(() => {
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
            <Note>
              {merchantStatusByEnum("store_asset.processing_state", detail.processingState)
                ?.label ?? "整理状态待确认"}{" "}
              · {detail.reviewState === "reviewed" ? "已复核" : "未复核"} ·{" "}
              {merchantStatusByEnum("moderation.state", detail.moderationState)?.label ??
                "审核状态待确认"}
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
                      {merchantStatusByEnum("moderation.state", file.moderationState)?.label ??
                        "审核状态待确认"}
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
            </Section>
            <Section title="使用记录">
              <Card>
                <Timeline
                  variant="record"
                  items={detail.timeline.map((item, n) => ({
                    key: n,
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
