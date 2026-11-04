import { Alert, Button, Card, Empty, Space, Spin, Tag, Typography } from "antd";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PortalRuntime } from "../../lib/runtime";
import { DownloadLayout } from "../items/DownloadLayout";
import { createItemApi } from "./api";
import { createItemModel, type ItemSnapshot } from "./model";
import { blockerText, dateText, sizeText } from "./presentation";

const { Title, Text, Paragraph } = Typography;
type Actions = Pick<
  ReturnType<typeof createItemModel>,
  "load" | "episode" | "zip" | "cancelZip" | "publishText"
>;
export function ItemContent({ state, actions }: { state: ItemSnapshot; actions: Actions }) {
  const release = state.release;
  return (
    <DownloadLayout>
      <header className="portal-download-heading">
        <div>
          <Title level={1}>{release ? `《${release.dramaTitle}》` : "成片详情"}</Title>
          <Paragraph type="secondary">按集或整包下载，浏览器会显示实际保存进度。</Paragraph>
        </div>
        <Button href="/items">返回成片列表</Button>
      </header>
      {state.error && (
        <Alert
          showIcon
          type="error"
          title={state.error}
          action={<Button onClick={() => void actions.load()}>重新加载成片</Button>}
        />
      )}
      {state.actionError && <Alert showIcon type="error" title={state.actionError} />}
      {state.notice && <Alert showIcon type="success" title={state.notice} />}
      {state.loading && !release ? (
        <div className="portal-download-loading">
          <Spin />
        </div>
      ) : null}
      {release ? (
        <>
          <Card className="portal-download-section">
            <div className="portal-download-summary">
              <div>
                <Text type="secondary">交付版本</Text>
                <strong>
                  第 {release.releaseNo} 版 · {release.episodeCount} 集
                </strong>
              </div>
              <div>
                <Text type="secondary">成片总大小</Text>
                <strong>{sizeText(release.totalBytes)}</strong>
              </div>
              <div>
                <Text type="secondary">下载有效期</Text>
                <strong>
                  {release.grant ? dateText(release.grant.expiresAt) : "暂无有效授权"}
                </strong>
              </div>
            </div>
            <Paragraph type="secondary">
              订单 {release.orderNo} · 交付于 {dateText(release.pushedAt)} · 使用至{" "}
              {release.usageEndDate}
            </Paragraph>
            {release.reissueReason && <Paragraph>补发原因：{release.reissueReason.name}</Paragraph>}
            {!release.isDownloadable && (
              <Alert type="warning" showIcon title={blockerText(release.downloadBlocker)} />
            )}
            <Space wrap>
              <Button
                type="primary"
                disabled={!release.isDownloadable || state.zip === "building"}
                onClick={() => void actions.zip(state.zip === "failed")}
              >
                {state.zip === "failed" ? "重新打包下载" : "下载整包 ZIP"}
              </Button>
              {state.zip === "building" && (
                <>
                  <Text>正在打包，约需几分钟；您也可以先逐集下载。</Text>
                  <Button onClick={actions.cancelZip}>停止等待</Button>
                </>
              )}
              {state.zip === "failed" && <Text>打包失败，请重试或逐集下载。</Text>}
              {state.zip === "timeout" && (
                <Text>等待已超过 10 分钟，已停止查询。请先逐集下载。</Text>
              )}
              {state.zip === "cancelled" && <Text>已停止等待，后台已有打包任务可能仍会继续。</Text>}
            </Space>
          </Card>
          <section aria-label="逐集下载" className="portal-download-section">
            <Title level={2}>逐集下载</Title>
            <div className="portal-download-episodes">
              {release.episodes.map((entry) => (
                <article key={entry.episodeNo} className="portal-download-episode">
                  <span className="portal-download-number">
                    {String(entry.episodeNo).padStart(2, "0")}
                  </span>
                  <div className="portal-download-episode-info">
                    <Text strong>{entry.fileName}</Text>
                    <Text type="secondary">
                      {sizeText(entry.sizeBytes)}
                      {entry.lastPortalDownloadAt
                        ? ` · 上次获取地址 ${dateText(entry.lastPortalDownloadAt)}`
                        : " · 尚未在电脑获取下载地址"}
                    </Text>
                  </div>
                  {entry.isChanged && <Tag>本次更新</Tag>}
                  <Button
                    disabled={
                      !release.isDownloadable ||
                      (state.episode !== null && state.episode !== entry.episodeNo)
                    }
                    loading={state.episode === entry.episodeNo}
                    onClick={() => void actions.episode(entry.episodeNo)}
                  >
                    下载第 {entry.episodeNo} 集
                  </Button>
                </article>
              ))}
            </div>
          </section>
          <section aria-label="发布清单" className="portal-download-section">
            <Title level={2}>发布清单</Title>
            {state.textError && (
              <Alert
                type="warning"
                showIcon
                title={state.textError}
                action={<Button onClick={() => void actions.load()}>重新读取清单</Button>}
              />
            )}
            {release.hasPublishList ? (
              <Card>
                <Space wrap>
                  <Button loading={state.textBusy} onClick={() => void actions.publishText(false)}>
                    复制发布清单
                  </Button>
                  <Button
                    disabled={!release.isDownloadable}
                    loading={state.textBusy}
                    onClick={() => void actions.publishText(true)}
                  >
                    下载清单文本
                  </Button>
                </Space>
                <Paragraph type="secondary">
                  清单文件尚未就绪时，会根据当前发布清单生成文本文件。
                </Paragraph>
                {state.publishList?.text ? (
                  <pre className="portal-download-text">{state.publishList.text}</pre>
                ) : (
                  <Text type="secondary">
                    {state.textError
                      ? "暂未取得清单文本，请重试。"
                      : state.publishList
                        ? "暂无可复制的清单文本。"
                        : "正在读取发布清单文本……"}
                  </Text>
                )}
              </Card>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发布清单" />
            )}
          </section>
        </>
      ) : null}
    </DownloadLayout>
  );
}
export function ItemPage({
  runtime,
  orderItemId,
}: {
  runtime: PortalRuntime;
  orderItemId: string;
}) {
  const model = useMemo(
    () => createItemModel(createItemApi(runtime.client), runtime.session, orderItemId),
    [runtime, orderItemId],
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    void model.load();
    return model.stop;
  }, [model]);
  return <ItemContent state={state} actions={model} />;
}
