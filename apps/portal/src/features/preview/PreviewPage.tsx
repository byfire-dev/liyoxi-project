import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Skeleton, Space, Typography, theme } from "antd";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import type { PortalRuntime } from "../../lib/runtime";
import { validPreviewId } from "./api";
import { createAdPreviewModel, initialAdPreview, type AdPreviewModel } from "./model";

export function previewDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function AdPreviewPage({ runtime, id }: { runtime: PortalRuntime; id: string }) {
  const { token } = theme.useToken();
  const [snapshot, setSnapshot] = useState(initialAdPreview);
  const [now, setNow] = useState(Date.now);
  const model = useRef<AdPreviewModel | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const current = createAdPreviewModel(runtime, id);
    model.current = current;
    const unsubscribe = current.subscribe(() => setSnapshot(current.getSnapshot()));
    void current.load();
    return () => {
      unsubscribe();
      current.dispose();
      if (model.current === current) model.current = null;
    };
  }, [runtime, id]);
  useEffect(() => {
    if (snapshot.retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.retryAt]);
  const src = snapshot.playback?.sources[0]?.url;
  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [src]);
  const detail = snapshot.detail;
  const cooling = snapshot.retryAt !== null && now < snapshot.retryAt;
  const busy = snapshot.status === "loading" || snapshot.media === "signing";
  return (
    <main
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: token.paddingLG,
        display: "grid",
        gap: token.marginLG,
      }}
    >
      <Typography.Title level={1}>广告预览</Typography.Title>
      <Alert type="info" showIcon title="本页仅供预览。请回到小程序确认广告或提出修改意见。" />
      {snapshot.notice === "version_changed" ? (
        <Alert
          role="status"
          type="warning"
          showIcon
          title="广告已有新版本，请重新查看后点击播放。"
        />
      ) : null}
      {snapshot.error ? (
        <Alert
          role="alert"
          type="error"
          showIcon
          title={snapshot.error.status === 404 ? "暂时无法查看此广告" : snapshot.error.message}
        />
      ) : null}
      {snapshot.status === "idle" || snapshot.status === "loading" ? (
        <Card>
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      ) : null}
      {snapshot.status === "invalid" ? (
        <Alert type="warning" title="暂时无法查看此广告，请核对当前电脑授权。" />
      ) : null}
      {detail ? (
        <>
          <Card title={`${detail.type === "opening" ? "片头" : "片尾"}广告 · ${detail.adNo}`}>
            <Space wrap size="large">
              <Typography.Text strong>当前已推送第 {detail.currentVersionNo} 版</Typography.Text>
              <Typography.Text>
                {statusToneByEnum("ad.status", detail.displayStatus)?.merchant?.label ??
                  (detail.displayStatus === "cancelled" ? "已取消" : "状态待核对")}
              </Typography.Text>
              <Typography.Text type="secondary">
                推送于 {appDateTimeFormat.dateTime(detail.currentVersionPushedAt)}
              </Typography.Text>
            </Space>
          </Card>
          <Card title="播放预览">
            <Space orientation="vertical" style={{ width: "100%" }} size="middle">
              {src ? (
                <video
                  key={src}
                  ref={video}
                  src={src}
                  controls
                  controlsList="nodownload"
                  preload="metadata"
                  autoPlay={false}
                  muted={false}
                  playsInline
                  aria-label="广告视频"
                  style={{
                    width: "100%",
                    maxHeight: 500,
                    objectFit: "contain",
                    background: token.colorBgLayout,
                  }}
                  onError={() => model.current?.mediaFailed()}
                />
              ) : (
                <div
                  style={{
                    minHeight: 180,
                    display: "grid",
                    placeItems: "center",
                    background: token.colorBgLayout,
                    padding: token.paddingLG,
                  }}
                >
                  <Typography.Text type="secondary">
                    {detail.isPortalPreviewable
                      ? "点击下方按钮获取本版播放地址"
                      : "当前暂不能在电脑预览"}
                  </Typography.Text>
                </div>
              )}
              {snapshot.media === "expired" ? (
                <Alert role="status" type="warning" title="播放地址已过期，请重新获取后播放。" />
              ) : null}
              {snapshot.media === "failed" && !snapshot.error ? (
                <Alert
                  role="alert"
                  type="warning"
                  title="视频未能继续播放。可重新获取播放地址，或回到小程序查看。"
                />
              ) : null}
              {!detail.isPortalPreviewable ? (
                <Alert
                  type="info"
                  title="当前暂不能在电脑预览，请回到小程序查看说明或联系服务经理。"
                />
              ) : (
                <Button
                  type="primary"
                  size="large"
                  loading={snapshot.media === "signing"}
                  disabled={busy || cooling}
                  onClick={() => {
                    void model.current?.play();
                  }}
                >
                  {cooling
                    ? "请稍后重试"
                    : snapshot.media === "expired" || snapshot.media === "failed"
                      ? "重新获取播放地址"
                      : `播放第 ${detail.currentVersionNo} 版`}
                </Button>
              )}
              <Typography.Text type="secondary">
                时长 {previewDuration(detail.currentVersion.durationMs)} ·{" "}
                {detail.currentVersion.width} × {detail.currentVersion.height}
              </Typography.Text>
              {detail.currentVersion.segments.length ? (
                <Space wrap aria-label="广告分段">
                  {detail.currentVersion.segments.map((segment) => (
                    <Button
                      key={segment.index}
                      disabled={!src}
                      onClick={() => {
                        const element = video.current;
                        if (element && src) element.currentTime = segment.fromMs / 1000;
                      }}
                    >
                      {segment.label} · {previewDuration(segment.fromMs)} 至{" "}
                      {previewDuration(segment.toMs)}
                    </Button>
                  ))}
                </Space>
              ) : null}
            </Space>
          </Card>
          <Card title="广告文案">
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {detail.copy ?? "暂无广告文案"}
            </Typography.Paragraph>
          </Card>
        </>
      ) : null}
      {snapshot.error?.error === "MAINTENANCE" ? (
        <Button onClick={() => window.location.reload()}>重新加载页面</Button>
      ) : (
        <Button
          disabled={busy || cooling || snapshot.status === "invalid"}
          onClick={() => {
            void model.current?.load();
          }}
        >
          {cooling ? "请稍后重试" : "刷新广告详情"}
        </Button>
      )}
    </main>
  );
}

export function PreviewPage({
  runtime,
  kind,
  id,
}: {
  runtime: PortalRuntime;
  kind: string;
  id: string;
}) {
  const { token } = theme.useToken();
  if (!validPreviewId(id) || (kind !== "ad" && kind !== "sample"))
    return (
      <main style={{ padding: token.paddingLG }}>
        <Typography.Title level={1}>暂时无法查看此内容</Typography.Title>
      </main>
    );
  if (kind === "sample")
    return (
      <main style={{ maxWidth: 800, margin: "0 auto", padding: token.paddingLG }}>
        <Typography.Title level={1}>样片请在小程序查看并确认</Typography.Title>
        <Alert
          type="info"
          showIcon
          title="请返回小程序打开样片，查看后勾选“我已查看”并完成确认。"
        />
      </main>
    );
  return <AdPreviewPage key={id} runtime={runtime} id={id} />;
}
