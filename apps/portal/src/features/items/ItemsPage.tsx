import { Alert, Button, Card, Empty, Space, Spin, Tag, Typography } from "antd";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PortalRuntime } from "../../lib/runtime";
import { blockerText, dateText, sizeText } from "../item/presentation";
import { createItemsApi } from "./api";
import { createItemsModel, type ItemsSnapshot } from "./model";
import { DownloadLayout } from "./DownloadLayout";

const { Title, Text, Paragraph } = Typography;
export function ItemsContent({
  state,
  load,
}: {
  state: ItemsSnapshot;
  load: (section: keyof ItemsSnapshot, more?: boolean) => Promise<void>;
}) {
  return (
    <DownloadLayout>
      <header className="portal-download-heading">
        <div>
          <Title level={1}>我的成片</Title>
          <Paragraph type="secondary">当前授权门店的成片与待确认广告。</Paragraph>
        </div>
      </header>
      <section aria-label="已交付成片" className="portal-download-section">
        <Title level={2}>已交付成片</Title>
        {state.orders.error && (
          <Alert
            showIcon
            type="error"
            title={state.orders.error}
            action={<Button onClick={() => void load("orders")}>重新加载成片</Button>}
          />
        )}
        {state.orders.loading && !state.orders.page ? (
          <Spin tip="正在读取成片">
            <div className="portal-download-loading" />
          </Spin>
        ) : null}
        <div className="portal-download-grid">
          {state.orders.page?.items.map((item) => (
            <Card key={item.orderItemId}>
              <div className="portal-download-cover">
                <span>狸有戏 · 成片</span>
                <strong>《{item.dramaTitle}》</strong>
                <small>{item.episodeCount} 集</small>
              </div>
              <Space>
                <Tag>{item.isDownloadable ? "可下载" : "暂不可下载"}</Tag>
                <Text type="secondary">
                  {item.release ? `第 ${item.release.releaseNo} 版` : "尚未交付"}
                </Text>
              </Space>
              <Title level={3}>《{item.dramaTitle}》</Title>
              <Paragraph type="secondary">
                订单 {item.orderNo}
                <br />
                {item.release
                  ? `${sizeText(item.release.totalBytes)} · ${dateText(item.release.pushedAt)}`
                  : ""}
              </Paragraph>
              {!item.isDownloadable && (
                <Paragraph type="secondary">{blockerText(item.downloadBlocker)}</Paragraph>
              )}
              <Button type="primary" block href={`/items/${encodeURIComponent(item.orderItemId)}`}>
                查看成片与下载
              </Button>
            </Card>
          ))}
        </div>
        {state.orders.page?.items.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该门店暂无已交付成片" />
        )}
        {state.orders.page?.hasMore && (
          <div className="portal-download-more">
            <Button loading={state.orders.loading} onClick={() => void load("orders", true)}>
              加载更多成片
            </Button>
          </div>
        )}
      </section>
      <section aria-label="待确认广告" className="portal-download-section">
        <Title level={2}>待确认广告</Title>
        <Paragraph type="secondary">电脑端可预览广告，请回到小程序确认或提出修改意见。</Paragraph>
        {state.ads.error && (
          <Alert
            showIcon
            type="error"
            title={state.ads.error}
            action={<Button onClick={() => void load("ads")}>重新加载广告</Button>}
          />
        )}
        {state.ads.loading && !state.ads.page ? (
          <Spin tip="正在读取广告">
            <div className="portal-download-loading" />
          </Spin>
        ) : null}
        <div className="portal-download-grid">
          {state.ads.page?.items.map((ad) => (
            <Card key={ad.adId}>
              <Tag>{ad.type === "opening" ? "片头广告" : "片尾广告"}</Tag>
              <Title level={3}>{ad.adNo}</Title>
              <Paragraph>{ad.copy || "暂无广告文案"}</Paragraph>
              <Paragraph type="secondary">
                第 {ad.currentVersionNo} 版 · {ad.durationSec} 秒<br />
                推送于 {dateText(ad.currentVersionPushedAt)}
              </Paragraph>
              {ad.isPortalPreviewable ? (
                <Button href={`/preview/ad/${encodeURIComponent(ad.adId)}`}>预览广告</Button>
              ) : (
                <Text type="secondary">当前版本暂不可在电脑预览，请回到小程序查看。</Text>
              )}
            </Card>
          ))}
        </div>
        {state.ads.page?.items.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该门店暂无待确认广告" />
        )}
        {state.ads.page?.hasMore && (
          <div className="portal-download-more">
            <Button loading={state.ads.loading} onClick={() => void load("ads", true)}>
              加载更多广告
            </Button>
          </div>
        )}
      </section>
    </DownloadLayout>
  );
}

export function ItemsPage({ runtime }: { runtime: PortalRuntime }) {
  const model = useMemo(
    () => createItemsModel(createItemsApi(runtime.client), runtime.session),
    [runtime],
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    void model.load("orders");
    void model.load("ads");
    return model.stop;
  }, [model]);
  return <ItemsContent state={state} load={model.load} />;
}
