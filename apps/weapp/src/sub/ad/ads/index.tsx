import { useRef, useState } from "react";
import Taro, { useReachBottom } from "@tarojs/taro";
import { View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Cover } from "@/components/Cover";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { Tabs } from "@/components/Tabs";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { useDeliveryIdentity } from "../../order/components/ui";
import { adApi, type AdTab } from "../private/api";
import { mergeAds, tabs } from "../private/model";
import { useAdResource, adOwner } from "../private/resource";
import { AdCreateForm } from "../private/create-form";
import "../private/ad.scss";

export default function AdsPage() {
  const identity = useDeliveryIdentity();
  return <Ads key={identity} />;
}
function Ads() {
  const [tab, setTab] = useState<AdTab>("all"),
    [create, setCreate] = useState(false);
  const selected = useRef(tab),
    cursors = useRef(new Set<string>());
  const r = useAdResource(() => {
    cursors.current.clear();
    return adApi.list(selected.current);
  });
  const open = (id: string) => {
    void Taro.navigateTo({ url: `/sub/ad/ad-detail/index?adId=${encodeURIComponent(id)}` });
  };
  const more = () =>
    r.run(async (current) => {
      const cursor = r.data?.nextCursor;
      if (!cursor || !r.data?.hasMore) return;
      if (cursors.current.has(cursor)) throw new Error("分页游标已失效，请下拉刷新");
      const next = await adApi.list(selected.current, cursor);
      if (current()) {
        cursors.current.add(cursor);
        r.replace(mergeAds(r.data, next), current);
      }
    });
  useReachBottom(more);
  return (
    <View className="ad-page" id={!r.loading ? "ad-ready" : undefined}>
      <Tabs
        sticky
        items={tabs}
        value={tab}
        onChange={(value) => {
          selected.current = value;
          setTab(value);
          cursors.current.clear();
          r.refresh();
        }}
      />
      <PageBody>
        {adOwner() ? (
          <Button block onClick={() => setCreate(true)}>
            制作新广告
          </Button>
        ) : null}
        {r.error ? <LoadError message={r.error} onRetry={r.refresh} /> : null}
        {r.loading ? (
          <Skeleton cards={3} />
        ) : r.data && !r.data.items.length ? (
          <Empty title="暂无广告" description="提交制作需求后，可在这里查看进度与确认版本" />
        ) : (
          r.data?.items.map((ad) => {
            const status = merchantStatusByEnum("ad.status", ad.status);
            return (
              <Card key={ad.adId}>
                <View className="ad-row">
                  <Cover variant="thumb" src={ad.coverUrl ?? undefined} title="广告" />
                  <View>
                    <View className="ad-title">
                      {ad.type === "opening" ? "片头" : "片尾"}贴片 · {ad.durationSec}秒
                    </View>
                    {status ? (
                      <StatusTag plain tone={status.tone}>
                        {status.label}
                      </StatusTag>
                    ) : (
                      <Note>{ad.displayStatus}</Note>
                    )}
                    <View>{ad.copy ?? ad.promoPoints.map((point) => point.name).join("、")}</View>
                    <View className="ad-muted">
                      {ad.adNo} · 剩余免费修改{ad.freeRevisionsRemaining}次
                    </View>
                    <View className="ad-muted">
                      更新于{appDateTimeFormat.dateTime(ad.updatedAt)}
                    </View>
                  </View>
                </View>
                {ad.waitingReason === "materials" ? (
                  <Note>待补充素材：{ad.returnReason}</Note>
                ) : ad.waitingReason === "qualification" ? (
                  <Note>门店资质审核中</Note>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => open(ad.adId)}>
                  查看广告详情
                </Button>
              </Card>
            );
          })
        )}
        {r.data?.hasMore ? (
          <Button block variant="outline" loading={r.busy} onClick={more}>
            加载更多广告
          </Button>
        ) : null}
        {create ? (
          <AdCreateForm
            close={() => setCreate(false)}
            done={(id) => {
              setCreate(false);
              open(id);
              r.refresh();
            }}
          />
        ) : null}
      </PageBody>
    </View>
  );
}
