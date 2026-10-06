import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { formatInteger, formatSignedPercent } from "@liyoxi/shared/format/money";
import { Cover } from "@/components/Cover";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Button } from "@/components/Button";
import { FooterBar } from "@/components/FooterBar";
import { PageBody } from "@/components/PageBody";
import { Note } from "@/components/Note";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import { gotoAccountLogin } from "@/lib/account-routing";
import { track } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { useCatalogStore } from "@/stores/catalog";
import { catalogApi } from "@/pages/mall/api";
import { useCatalogResource } from "@/pages/mall/resource";
import "./index.scss";
const platformName: Readonly<Record<string, string>> = {
  douyin: "抖音",
  wechat_channels: "视频号",
  all: "通用",
};
export default function DetailPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken),
    { dramaId = "" } = useRouter().params;
  return <DetailContent key={`${rev}:${token}:${dramaId}`} id={dramaId} />;
}
function DetailContent({ id }: { id: string }) {
  const resource = useCatalogResource(
      () =>
        id ? catalogApi.detail(id) : Promise.reject(new Error("缺少短剧编号，请返回商城选择")),
      id,
    ),
    detail = resource.data;
  const [busy, setBusy] = useState(false),
    [added, setAdded] = useState(false),
    [error, setError] = useState<string | null>(null),
    active = useRef(false);
  useEffect(() => {
    if (detail) track("drama_detail_view", { dramaId: detail.dramaId, fromPage: "mall" });
  }, [detail]);
  const add = async () => {
    if (
      !detail ||
      detail.viewerRole !== "owner" ||
      !detail.orderability.orderable ||
      active.current
    )
      return;
    const current = resource.guard();
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const item = await catalogApi.add(detail.dramaId);
      if (!current()) return;
      useCatalogStore.getState().added(item.cartItemId, Boolean(detail.owner?.cartItemId));
      setAdded(true);
      // natural create没有created标记；读真实列表校正并发重复与角标。
      const cart = await catalogApi.cart();
      if (!current()) return;
      useCatalogStore.getState().reconcileCart(cart.items);
      void Taro.showToast({ title: "已加入选剧单", icon: "none" });
    } catch (e: unknown) {
      if (current()) setError(e instanceof Error ? e.message : "加入失败，请重试");
    } finally {
      if (current()) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <View className="detail-page" id={detail ? "catalog-ready" : undefined}>
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!detail ? (
          <Skeleton cards={3} />
        ) : (
          <>
            <Card>
              <View className="detail-page__header">
                <View className="detail-page__cover">
                  <Cover title={detail.title} src={detail.posterUrl?.url} />
                </View>
                <View className="detail-page__intro">
                  <View className="detail-page__title">{detail.title}</View>
                  <View className="detail-page__muted">
                    {detail.genres.map((g) => g.name).join(" · ")}
                  </View>
                  <View>
                    {detail.totalEpisodes} 集
                    {detail.episodeDurationSec ? ` · 每集 ${detail.episodeDurationSec} 秒` : ""}
                  </View>
                  <View className="detail-page__price">
                    {detail.viewerRole === "owner" && detail.discountedPoints !== null
                      ? `${formatInteger(detail.discountedPoints)} 积分`
                      : detail.listPricePoints !== null
                        ? `${formatInteger(detail.listPricePoints)} 积分`
                        : "暂无报价"}
                  </View>
                </View>
              </View>
              {detail.viewerRole === "owner" && detail.owner ? (
                <DescList
                  items={[
                    {
                      label: "原价",
                      value:
                        detail.listPricePoints === null
                          ? "暂无报价"
                          : `${formatInteger(detail.listPricePoints)} 积分`,
                    },
                    { label: "当前套餐", value: detail.owner.planName ?? "暂未开通" },
                    {
                      label: "套餐折扣",
                      value:
                        detail.owner.discountBp === null
                          ? "开通后查看"
                          : formatSignedPercent(detail.owner.discountBp).replace("+", ""),
                    },
                    {
                      label: "可用积分",
                      value: `${formatInteger(detail.owner.spendablePoints)} 积分`,
                    },
                  ]}
                />
              ) : null}
            </Card>
            {!detail.orderability.orderable ? (
              <Note>
                {detail.orderability.reason === "not_listed" ? "已下架，暂不可订购" : "已停止订购"}
              </Note>
            ) : null}
            <Card title="短剧介绍">
              <View className="detail-page__copy">{detail.synopsis ?? "暂无简介"}</View>
              <DescList
                items={[
                  { label: "制作方", value: detail.producerName ?? "暂无" },
                  { label: "主演", value: detail.castNames ?? "暂无" },
                  {
                    label: "适合行业",
                    value: detail.industries.map((g) => g.name).join("、") || "暂无",
                  },
                  { label: "目标观众", value: detail.targetAudience ?? "暂无" },
                ]}
              />
              {detail.roles.map((r) => (
                <View key={r.name} className="detail-page__muted">
                  {r.name}
                  {r.actor ? `（${r.actor}）` : ""} · {r.desc}
                </View>
              ))}
            </Card>
            <Card title="定制说明">
              <View className="detail-page__copy">
                品牌信息可按许可位置出现在片头或片尾，具体方案以订购后的确认为准。
              </View>
              <DescList
                items={detail.placementDurations
                  .filter((p) => detail.allowedPlacements.includes(p.slot))
                  .map((p) => ({
                    label: p.slot === "opening" ? "片头" : "片尾",
                    value: p.durationSecOptions.map((n) => `${n} 秒`).join(" / "),
                  }))}
              />
              {detail.sellingTags.map((t) => (
                <View key={t.code}>
                  {t.name}
                  {t.description ? ` · ${t.description}` : ""}
                </View>
              ))}
            </Card>
            <Card title="使用范围">
              <DescList
                items={[
                  {
                    label: "发布平台",
                    value: detail.platforms.map((p) => platformName[p]).join("、"),
                  },
                  { label: "可使用至", value: detail.usableUntilDate ?? "暂无" },
                  ...detail.permits.map((p) => ({
                    label: `${platformName[p.platform]}许可`,
                    value: p.number,
                  })),
                ]}
              />
            </Card>
            {error ? <Note>{error}</Note> : null}
            {detail.viewerRole === "owner" ? (
              <>
                <FooterBar>
                  <Button
                    variant="secondary"
                    loading={busy}
                    disabled={!detail.orderability.orderable}
                    onClick={() => {
                      void add();
                    }}
                  >
                    {added || detail.owner?.cartItemId ? "已在选剧单" : "加入选剧单"}
                  </Button>
                  <Button
                    disabled={!detail.orderability.orderable || busy || resource.loading}
                    onClick={() => {
                      void Taro.navigateTo({
                        url: `/sub/order/checkout/index?dramaIds=${encodeURIComponent(detail.dramaId)}`,
                      });
                    }}
                  >
                    确认订购
                  </Button>
                </FooterBar>
              </>
            ) : detail.viewerRole === "guest" ? (
              <Button
                onClick={() => {
                  void gotoAccountLogin();
                }}
              >
                登录后管理选剧单
              </Button>
            ) : (
              <Note>仅老板可加入选剧单与订购</Note>
            )}
          </>
        )}
      </PageBody>
    </View>
  );
}
