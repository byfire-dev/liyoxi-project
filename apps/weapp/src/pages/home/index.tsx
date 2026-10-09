import { useEffect, useState } from "react";
import { Image, Swiper, SwiperItem, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { NavBar } from "@/components/NavBar";
import { Card } from "@/components/Card";
import { PageBody } from "@/components/PageBody";
import { Button } from "@/components/Button";
import { FilterChips } from "@/components/FilterChips";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import { List, ListRow } from "@/components/List";
import { useMessageBadge } from "@/stores/messages";
import { track } from "@/lib/runtime";
import { catalogScope, useCatalogStore, type Home } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { WEAPP_PAGES } from "@/pages";
import { catalogApi } from "../mall/api";
import { useCatalogResource, useCatalogBadge } from "../mall/resource";
import { DramaCards, openDrama } from "../mall/cards";
import "../mall/catalog.scss";
import "./index.scss";
function bannerClick(banner: Home["banners"][number], role: Home["viewerRole"]) {
  track("banner_click", { homeBannerId: banner.homeBannerId });
  if (banner.jumpKind === "drama") return openDrama(banner.jumpTarget.dramaId);
  if (banner.jumpKind === "mall") {
    useCatalogStore.getState().setCategory(banner.jumpTarget.categoryKey);
    void Taro.switchTab({ url: "/pages/mall/index" });
    return;
  }
  if (banner.jumpKind !== "page") return;
  const target = banner.jumpTarget;
  if ("storeId" in target.params && target.params.storeId !== catalogScope().storeId) {
    void Taro.showToast({ title: "请先切换到对应门店", icon: "none" });
    return;
  }
  const route =
    target.route === "wallet.home"
      ? "sub/billing/wallet/index"
      : target.route === "cart.list"
        ? "pages/cart/index"
        : target.route === "profile.review"
          ? "sub/profile/review/index"
          : "";
  if (role !== "owner" && (route === "sub/billing/wallet/index" || route === "pages/cart/index")) {
    void Taro.showToast({ title: "仅老板可管理钱包与选剧单", icon: "none" });
    return;
  }
  if (!WEAPP_PAGES.some((p) => p.route === route && p.implemented)) {
    void Taro.showToast({ title: "即将开放", icon: "none" });
    return;
  }
  if (route === "pages/cart/index") void Taro.switchTab({ url: `/${route}` });
  else void Taro.navigateTo({ url: `/${route}` });
}
export default function HomePage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <HomeContent key={`${rev}:${token}`} />;
}
function HomeContent() {
  const unread = useMessageBadge();
  const resource = useCatalogResource(catalogApi.home),
    home = resource.data;
  const [chosenTab, setTab] = useState<string | null>(null);
  const tab = chosenTab ?? (home && home.viewerRole !== "clerk" ? home.defaultTab : "hot");
  const guard = resource.guard;
  useCatalogBadge();
  useEffect(() => {
    if (!home || !guard()()) return;
    useCatalogStore.getState().setBadge(home.viewerRole === "owner" ? home.cartCount : 0);
  }, [home, guard]);
  const overview = home?.viewerRole === "owner" ? home.launchOverview : null;
  return (
    <View className="catalog-page home-page" id={home ? "catalog-ready" : undefined}>
      <NavBar>
        <View className="home-page__brand">狸有戏</View>
        <View className="home-page__city">{home?.city?.name ?? "全国"}</View>
      </NavBar>
      <PageBody>
        <Button
          variant="secondary"
          size="md"
          icon="search"
          block
          onClick={() => {
            void Taro.navigateTo({ url: "/sub/catalog/search/index?from=home" });
          }}
        >
          搜索剧名、题材、主演
        </Button>
        <List>
          <ListRow
            title="消息"
            description="查看门店与账号通知"
            badge={unread ?? undefined}
            onClick={() => {
              void Taro.navigateTo({ url: "/sub/service/messages/index" });
            }}
          />
        </List>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!home ? (
          <Skeleton cards={3} />
        ) : (
          <>
            {home.banners.length > 0 ? (
              <Swiper
                className="home-page__banners"
                indicatorDots
                autoplay
                interval={5000}
                circular
              >
                {home.banners.map((banner) => (
                  <SwiperItem key={banner.homeBannerId}>
                    <View
                      className="home-page__banner"
                      onClick={() => bannerClick(banner, home.viewerRole)}
                    >
                      <Image
                        src={banner.imageUrl.url}
                        mode="aspectFill"
                        className="home-page__banner-image"
                      />
                      <View className="home-page__banner-title">{banner.title}</View>
                    </View>
                  </SwiperItem>
                ))}
              </Swiper>
            ) : null}
            {overview ? (
              <Card
                title="上线概览"
                extra={
                  <View
                    onClick={() => {
                      void Taro.navigateTo({ url: "/sub/billing/wallet/index" });
                    }}
                  >
                    查看钱包
                  </View>
                }
              >
                <View className="home-page__stats">
                  <View>
                    <View className="home-page__number">
                      {formatInteger(overview.liveItemCount)}
                    </View>
                    <View className="catalog-muted">上线短剧</View>
                  </View>
                  <View>
                    <View className="home-page__number">
                      {formatInteger(overview.liveEpisodeCount)}
                    </View>
                    <View className="catalog-muted">上线集数</View>
                  </View>
                  <View>
                    <View className="home-page__number">
                      {formatInteger(overview.spendablePoints)}
                    </View>
                    <View className="catalog-muted">可用积分</View>
                  </View>
                </View>
                <View className="catalog-muted catalog-gap">
                  {overview.planName ?? "暂未开通套餐"}
                  {overview.termEndDate ? ` · 有效至 ${overview.termEndDate}` : ""}
                </View>
                {overview.expiringPlanPoints > 0 && overview.planPointsExpireAt ? (
                  <View className="catalog-muted">
                    {formatInteger(overview.expiringPlanPoints)} 积分将在{" "}
                    {appDateTimeFormat.dateTime(overview.planPointsExpireAt)} 到期
                  </View>
                ) : null}
              </Card>
            ) : null}
            {home.viewerRole === "owner" && home.recommend && home.recommend.items.length > 0 ? (
              <Card title="为您推荐">
                <View className="catalog-muted">
                  {home.recommend.matchBy
                    ? `${home.recommend.matchBy.industry.name}${home.recommend.matchBy.category ? ` · ${home.recommend.matchBy.category.name}` : ""}`
                    : "适合本店的短剧"}
                </View>
                <DramaCards horizontal items={home.recommend.items} />
              </Card>
            ) : null}
            {home.viewerRole === "clerk" ? (
              <Empty
                title="浏览短剧商城"
                description="订购与选剧单由老板管理"
                actionText="去商城"
                onAction={() => {
                  void Taro.switchTab({ url: "/pages/mall/index" });
                }}
              />
            ) : (
              <>
                <FilterChips
                  items={[
                    { key: "hot", label: "推荐" },
                    { key: "new", label: "新上架" },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
                <DramaCards items={tab === "new" ? home.new : home.hot} />
                {(tab === "new" ? home.new : home.hot).length === 0 ? (
                  <Empty title="暂无短剧" />
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    void Taro.switchTab({ url: "/pages/mall/index" });
                  }}
                >
                  浏览全部短剧
                </Button>
              </>
            )}
          </>
        )}
      </PageBody>
    </View>
  );
}
