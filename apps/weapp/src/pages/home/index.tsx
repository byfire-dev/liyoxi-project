import { useEffect, useState } from "react";
import { Image, Swiper, SwiperItem, Text, View } from "@tarojs/components";
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
import { Badge } from "@/components/Badge";
import { Icon, type IconName } from "@/components/Icon";
import { TextButton } from "@/components/TextButton";
import { useMessageBadge } from "@/stores/messages";
import { track } from "@/lib/runtime";
import { getNavMetrics } from "@/lib/nav";
import { uuid } from "@/lib/platform";
import { catalogScope, useCatalogStore, type Home } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { WEAPP_PAGES } from "@/pages";
import { catalogApi } from "../mall/api";
import { useCatalogResource, useCatalogBadge } from "../mall/resource";
import { DramaCards, openDrama } from "../mall/cards";
import { HomeAssets } from "../../sub/asset/private/home-assets";
import { createBannerImageRetry } from "./banner-image-retry";
import { createBannerImageRequester } from "./banner-image-request";
import "../mall/catalog.scss";
import "./index.scss";
function bannerImageOrigin(source: string) {
  return source.match(/^https?:\/\/[^/]+/)?.[0] ?? "local";
}
function bannerImageHash(source: string) {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function bannerImageIdentity(source: string) {
  return {
    origin: bannerImageOrigin(source),
    resourceHash: bannerImageHash(source.split("?")[0] ?? source),
    urlHash: bannerImageHash(source),
    sourceLength: source.length,
  };
}
function bannerImageError(message: string) {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, "[图片地址]").slice(0, 240);
}
function HomeBannerImage({ remoteSource }: { remoteSource: string }) {
  const [source, setSource] = useState(remoteSource);
  const [requester] = useState(() =>
    createBannerImageRequester({
      request(url) {
        const startedAt = Date.now();
        let receivedHeaders = false;
        const task = Taro.request<ArrayBuffer>({
          url,
          method: "GET",
          dataType: "text",
          responseType: "arraybuffer",
          timeout: 15_000,
        });
        task.onHeadersReceived(() => {
          receivedHeaders = true;
        });
        return {
          promise: task.then(
            (result) => ({
              statusCode: result.statusCode,
              data: result.data,
              server: String(result.header["Server"] ?? result.header["server"] ?? "unknown"),
              contentType: String(
                result.header["Content-Type"] ?? result.header["content-type"] ?? "unknown",
              ),
            }),
            (error: unknown) => {
              const message =
                typeof error === "object" && error !== null && "errMsg" in error
                  ? String(error.errMsg)
                  : "request:fail";
              throw new Error(
                `${bannerImageError(message)}; receivedHeaders=${receivedHeaders}; elapsedMs=${Date.now() - startedAt}`,
              );
            },
          ),
          abort: () => task.abort(),
        };
      },
      write(bytes, contentType) {
        const directory = Taro.env.USER_DATA_PATH;
        if (!directory) throw new Error("本地图片目录不可用");
        const extension = /image\/jpe?g/i.test(contentType ?? "") ? "jpg" : "png";
        const path = `${directory}/home-banner-${uuid()}.${extension}`;
        const files = Taro.getFileSystemManager();
        try {
          files.writeFileSync(path, bytes);
        } catch (error) {
          try {
            files.unlinkSync(path);
          } catch {
            // 写入失败可能没有创建文件；只清理本次分配的路径。
          }
          throw error;
        }
        return path;
      },
      remove(path) {
        Taro.getFileSystemManager().unlinkSync(path);
      },
    }),
  );
  const [retry] = useState(() =>
    createBannerImageRetry({
      source: remoteSource,
      download: requester.download,
      onReady: setSource,
      onResult(result) {
        if (result.statusCode !== undefined)
          console.info("[首页 Banner] 下载响应", {
            ...bannerImageIdentity(remoteSource),
            transport: "request",
            statusCode: result.statusCode,
            ...result.details,
          });
        if (result.error !== undefined)
          console.error("[首页 Banner] 下载失败", {
            ...bannerImageIdentity(remoteSource),
            transport: "request",
            error: bannerImageError(
              typeof result.error === "object" && result.error !== null && "errMsg" in result.error
                ? String(result.error.errMsg)
                : result.error instanceof Error
                  ? result.error.message
                  : "下载未完成",
            ),
          });
      },
    }),
  );
  useEffect(() => {
    requester.activate();
    retry.activate();
    return () => {
      retry.dispose();
      requester.dispose();
    };
  }, [retry, requester, remoteSource]);
  return (
    <Image
      src={source}
      mode="aspectFill"
      className="home-page__banner-image"
      onLoad={({ detail }) => {
        console.info("[首页 Banner] 图片加载成功", {
          ...bannerImageIdentity(remoteSource),
          sourceKind: source === remoteSource ? "remote" : "downloaded",
          width: detail.width,
          height: detail.height,
        });
      }}
      onError={({ detail }) => {
        console.error("[首页 Banner] 图片加载失败", {
          ...bannerImageIdentity(remoteSource),
          sourceKind: source === remoteSource ? "remote" : "downloaded",
          error: bannerImageError(detail.errMsg),
        });
        if (source === remoteSource) retry.retry();
      }}
    />
  );
}
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
const homeShortcuts: { title: string; icon: IconName; route: string | null }[] = [
  { title: "商家建档", icon: "store", route: "sub/profile/profile/index" },
  { title: "我的广告", icon: "megaphone", route: "sub/ad/ads/index" },
  { title: "发布任务", icon: "upload", route: "sub/publish/tasks/index" },
  { title: "联系客服", icon: "headset", route: null },
];
const homePageImplemented = (route: string) =>
  WEAPP_PAGES.some((page) => page.route === route && page.implemented);
const homeMonthDay = (date: string) => appDateTimeFormat.date(date).slice(5).replace("-", "/");

function HomeShortcuts({ role }: { role: Home["viewerRole"] }) {
  return (
    <View className="home-page__shortcuts">
      {homeShortcuts.map((item) => {
        const route = item.route;
        const enabled = role === "owner" && route !== null && homePageImplemented(route);
        return (
          <View
            key={item.title}
            className={`home-page__shortcut${enabled ? "" : " home-page__shortcut--unavailable"}`}
            ariaRole={enabled ? "button" : undefined}
            hoverClass={enabled ? "home-page__shortcut--pressed" : "none"}
            onClick={
              enabled
                ? () => {
                    void Taro.navigateTo({ url: `/${route}` });
                  }
                : undefined
            }
          >
            <View className="home-page__shortcut-icon">
              <Icon name={item.icon} size={24} />
            </View>
            <View className="home-page__shortcut-title">{item.title}</View>
            {!enabled ? (
              <View className="home-page__shortcut-note">
                {route === null || !homePageImplemented(route) ? "暂未开放" : "仅老板可用"}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
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
  useEffect(() => {
    if (!home) return;
    console.info("[首页 Banner] 图片来源", {
      build: "banner-request-20261010",
      images: home.banners.map((banner) => ({
        ...bannerImageIdentity(banner.imageUrl.url),
        expiresAt: banner.imageUrl.expiresAt,
      })),
    });
  }, [home]);
  useEffect(() => {
    let current = true;
    void Taro.getNetworkType().then(
      (network) => {
        if (current)
          console.info("[首页 Banner] 微信网络", {
            networkType: network.networkType,
            hasSystemProxy: network.hasSystemProxy ?? "unknown",
          });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const overview = home?.viewerRole === "owner" ? home.launchOverview : null;
  const notice = home?.viewerRole === "owner" ? home.noticeBar : null;
  // 与 NavBar 的右侧胶囊预留对称，保持品牌字在屏幕中央；设备像素不走 rpx 转换。
  const nav = getNavMetrics();
  return (
    <View className="catalog-page home-page" id={home ? "catalog-ready" : undefined}>
      <NavBar>
        <View
          className="home-page__nav-title"
          style={{ paddingLeft: `${Math.max(nav.right - 16, 0)}px` }}
        >
          <View className="home-page__brand">狸有戏</View>
        </View>
      </NavBar>
      <PageBody>
        <View className="home-page__search-row">
          <View className="home-page__city">
            <Icon name="map-pin" size={18} />
            <Text className="home-page__city-name">{home?.city?.name ?? "全国"}</Text>
          </View>
          <Button
            variant="secondary"
            size="md"
            icon="search"
            className="home-page__search"
            onClick={() => {
              void Taro.navigateTo({ url: "/sub/catalog/search/index?from=home" });
            }}
          >
            搜索剧名、题材、主演
          </Button>
        </View>
        <Card className="home-page__updates">
          {notice ? (
            <View className="home-page__update home-page__update--notice">
              <Text className="home-page__update-tag">公告</Text>
              <View className="home-page__update-content">
                <View className="home-page__update-title">{notice.title}</View>
                <View className="home-page__update-summary">{notice.summary}</View>
              </View>
            </View>
          ) : null}
          <View
            className="home-page__update"
            ariaRole="button"
            ariaLabel="查看门店与账号通知"
            hoverClass="home-page__update--pressed"
            onClick={() => {
              void Taro.navigateTo({ url: "/sub/service/messages/index" });
            }}
          >
            <Text className="home-page__update-tag">消息</Text>
            <View className="home-page__update-content">
              <View className="home-page__update-title">查看门店与账号通知</View>
            </View>
            <Badge count={unread ?? undefined} />
            <Icon name="chevron-right" size={18} />
          </View>
        </Card>
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
                      <HomeBannerImage
                        key={banner.imageUrl.url}
                        remoteSource={banner.imageUrl.url}
                      />
                      <View className="home-page__banner-title">{banner.title}</View>
                    </View>
                  </SwiperItem>
                ))}
              </Swiper>
            ) : (
              <View
                className="home-page__promo"
                ariaRole="button"
                ariaLabel="浏览短剧商城"
                hoverClass="home-page__promo--pressed"
                onClick={() => {
                  void Taro.switchTab({ url: "/pages/mall/index" });
                }}
              >
                <View className="home-page__promo-copy">
                  <View className="home-page__promo-eyebrow">发现好故事</View>
                  <View className="home-page__promo-title">短剧商城</View>
                  <View className="home-page__promo-description">
                    寻找适合门店的故事 <Icon name="chevron-right" size={14} />
                  </View>
                </View>
                <View className="home-page__promo-posters">
                  <View className="home-page__promo-poster home-page__promo-poster--first" />
                  <View className="home-page__promo-poster home-page__promo-poster--second" />
                  <View className="home-page__promo-poster home-page__promo-poster--third" />
                </View>
              </View>
            )}
            <HomeShortcuts role={home.viewerRole} />
            {overview ? (
              <Card
                className="home-page__overview"
                title="上线概览"
                extra={
                  <TextButton
                    tone="muted"
                    arrow
                    onClick={() => {
                      void Taro.navigateTo({ url: "/sub/order/orders/index" });
                    }}
                  >
                    全部订单
                  </TextButton>
                }
              >
                <View className="home-page__stats">
                  <View className="home-page__stat">
                    <View className="home-page__stat-value">
                      <Text className="home-page__number">
                        {formatInteger(overview.liveItemCount)}
                      </Text>
                      <Text className="home-page__stat-unit">部</Text>
                    </View>
                    <View className="home-page__stat-label">上线中</View>
                  </View>
                  <View className="home-page__stat">
                    <View className="home-page__stat-value">
                      <Text className="home-page__number">
                        {formatInteger(overview.liveEpisodeCount)}
                      </Text>
                      <Text className="home-page__stat-unit">集</Text>
                    </View>
                    <View className="home-page__stat-label">已上线</View>
                  </View>
                  <View className="home-page__stat">
                    <View className="home-page__stat-value">
                      <Text className="home-page__number">
                        {formatInteger(overview.spendablePoints)}
                      </Text>
                    </View>
                    <View className="home-page__stat-label">可用积分</View>
                  </View>
                </View>
                <View
                  className="home-page__plan"
                  ariaRole="button"
                  ariaLabel="查看套餐与积分"
                  hoverClass="home-page__plan--pressed"
                  onClick={() => {
                    void Taro.navigateTo({ url: "/sub/billing/wallet/index" });
                  }}
                >
                  <View className="home-page__plan-badge">
                    <Icon name="crown" size={14} />
                    <Text className="home-page__plan-name">
                      {overview.planName ?? "未开通套餐"}
                    </Text>
                  </View>
                  <View className="home-page__plan-detail">
                    {overview.termEndDate
                      ? `${homeMonthDay(overview.termEndDate)} 到期`
                      : "查看套餐与积分"}
                  </View>
                  <Icon name="chevron-right" size={16} />
                </View>
                {overview.expiringPlanPoints > 0 && overview.planPointsExpireAt ? (
                  <View className="home-page__expiry">
                    {formatInteger(overview.expiringPlanPoints)} 套餐积分将在{" "}
                    {appDateTimeFormat.dateTime(overview.planPointsExpireAt).replace("-", "/")}{" "}
                    到期清零
                  </View>
                ) : null}
              </Card>
            ) : null}
            {home.viewerRole === "owner" && home.recommend && home.recommend.items.length > 0 ? (
              <View className="home-page__recommend">
                <View className="home-page__section-head">
                  <View className="home-page__section-title">为您推荐</View>
                  <View className="home-page__match">
                    {home.recommend.matchBy
                      ? `按“${home.recommend.matchBy.category?.name ?? home.recommend.matchBy.industry.name}”匹配`
                      : "适合本店的短剧"}
                  </View>
                </View>
                <DramaCards horizontal items={home.recommend.items} />
              </View>
            ) : null}
            {home.viewerRole === "owner" || home.viewerRole === "clerk" ? <HomeAssets /> : null}
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
