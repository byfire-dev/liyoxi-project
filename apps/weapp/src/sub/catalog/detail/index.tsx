import { useEffect, useRef, useState } from "react";
import { Text, View } from "@tarojs/components";
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
import { Icon } from "@/components/Icon";
import { InfoTag } from "@/components/InfoTag";
import { TextButton } from "@/components/TextButton";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { TrailerPlayer } from "../trailer/player";
import { useTrailerIdentity } from "../trailer/scope";
import { gotoAccountLogin } from "@/lib/account-routing";
import { track } from "@/lib/runtime";
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
  const identity = useTrailerIdentity();
  const { dramaId = "" } = useRouter().params;
  return <DetailContent key={`${identity}:${dramaId}`} id={dramaId} />;
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
      {detail ? (
        detail.trailer ? (
          <TrailerPlayer
            key={detail.trailer.playableId}
            trailer={detail.trailer}
            title={detail.title}
            blocked={resource.loading}
          />
        ) : (
          <View className="detail-page__hero">
            <Cover
              title={detail.title}
              src={detail.posterUrl?.url}
              className="detail-page__hero-cover"
            />
            <View className="detail-page__hero-note">暂无预告片</View>
          </View>
        )
      ) : null}
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
            <Card className="detail-page__identity">
              <View className="detail-page__title">《{detail.title}》</View>
              <View className="detail-page__tags">
                {detail.genres.map((genre) => (
                  <InfoTag key={genre.code}>{genre.name}</InfoTag>
                ))}
                {detail.heatTier ? <InfoTag>选用量等级 {detail.heatTier}</InfoTag> : null}
                <InfoTag>{detail.totalEpisodes} 集</InfoTag>
                {detail.episodeDurationSec ? (
                  <InfoTag>单集 {detail.episodeDurationSec} 秒</InfoTag>
                ) : null}
                {detail.badge ? (
                  <InfoTag>{detail.badge === "new" ? "新剧" : "推荐"}</InfoTag>
                ) : null}
              </View>
              <View className="detail-page__muted">出品方：{detail.producerName ?? "暂无"}</View>
            </Card>
            <Card className="detail-page__pricing">
              <View className="detail-page__price-row">
                <View className="detail-page__heading">积分价</View>
                <View className="detail-page__price">
                  {detail.listPricePoints === null ? (
                    "暂无报价"
                  ) : (
                    <>
                      <Text className="detail-page__price-number">
                        {formatInteger(detail.listPricePoints)}
                      </Text>
                      <Text className="detail-page__price-unit">积分</Text>
                    </>
                  )}
                </View>
              </View>
              {detail.viewerRole === "owner" && detail.owner ? (
                <>
                  <View className="detail-page__plan">
                    <View className="detail-page__plan-badge">
                      <Icon name="crown" size={14} />
                      <Text>{detail.owner.planName ?? "未开通套餐"}</Text>
                    </View>
                    <View className="detail-page__plan-discount">
                      {detail.owner.discountBp === null
                        ? "开通后查看折扣"
                        : `套餐折扣 ${formatSignedPercent(detail.owner.discountBp).replace("+", "")}`}
                    </View>
                    {detail.discountedPoints !== null ? (
                      <View className="detail-page__deduction">
                        实扣 {formatInteger(detail.discountedPoints)} 积分
                      </View>
                    ) : null}
                  </View>
                  <View className="detail-page__promise">
                    订购后为您的门店单独定制，成片仅在所选账号发布
                  </View>
                  <TextButton
                    tone="muted"
                    arrow
                    className="detail-page__wallet"
                    onClick={() => {
                      void Taro.navigateTo({ url: "/sub/billing/wallet/index" });
                    }}
                  >
                    当前可用 {formatInteger(detail.owner.spendablePoints)} 积分
                    {detail.owner.expiringPlanPoints > 0 && detail.owner.planPointsExpireAt
                      ? `，其中 ${formatInteger(detail.owner.expiringPlanPoints)} 将于 ${appDateTimeFormat.dateTime(detail.owner.planPointsExpireAt)} 到期清零`
                      : ""}
                  </TextButton>
                </>
              ) : null}
            </Card>
            {!detail.orderability.orderable ? (
              <Note>
                {detail.orderability.reason === "not_listed" ? "已下架，暂不可订购" : "已停止订购"}
              </Note>
            ) : null}
            <Card title="剧情简介">
              <View className="detail-page__copy">{detail.synopsis ?? "暂无简介"}</View>
              <DescList
                items={[
                  { label: "主演", value: detail.castNames ?? "暂无" },
                  {
                    label: "适合行业",
                    value: detail.industries.map((genre) => genre.name).join("、") || "暂无",
                  },
                  { label: "目标观众", value: detail.targetAudience ?? "暂无" },
                ]}
              />
              {detail.roles.map((role) => (
                <View key={role.name} className="detail-page__muted">
                  {role.name}
                  {role.actor ? `（${role.actor}）` : ""} · {role.desc}
                </View>
              ))}
            </Card>
            <Card title="定制说明">
              <View className="detail-page__copy">
                品牌信息可按许可位置出现在片头或片尾，具体方案以订购后的确认为准。
              </View>
              <DescList
                items={detail.placementDurations
                  .filter((placement) => detail.allowedPlacements.includes(placement.slot))
                  .map((placement) => ({
                    label: placement.slot === "opening" ? "片头" : "片尾",
                    value: placement.durationSecOptions
                      .map((seconds) => `${seconds} 秒`)
                      .join(" / "),
                  }))}
              />
              {detail.sellingTags.map((tag) => (
                <View key={tag.code} className="detail-page__copy">
                  {tag.name}
                  {tag.description ? ` · ${tag.description}` : ""}
                </View>
              ))}
            </Card>
            <Card title="使用范围">
              <DescList
                items={[
                  {
                    label: "发布平台",
                    value: detail.platforms.map((platform) => platformName[platform]).join("、"),
                  },
                  { label: "可使用至", value: detail.usableUntilDate ?? "暂无" },
                  ...detail.permits.map((permit) => ({
                    label: `${platformName[permit.platform]}许可`,
                    value: permit.number,
                  })),
                ]}
              />
            </Card>
            {error ? <Note>{error}</Note> : null}
            {detail.viewerRole === "owner" ? (
              <FooterBar equal={false} className="detail-page__footer">
                <View className="detail-page__unavailable">
                  <Icon name="headset" size={22} />
                  <View className="detail-page__unavailable-label">客服</View>
                  <View className="detail-page__unavailable-note">未开放</View>
                </View>
                <View className="detail-page__unavailable">
                  <Icon name="heart" size={22} />
                  <View className="detail-page__unavailable-label">收藏</View>
                  <View className="detail-page__unavailable-note">未开放</View>
                </View>
                <Button
                  variant="outline"
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
