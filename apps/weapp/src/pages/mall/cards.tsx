import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Cover } from "@/components/Cover";
import type { DramaCard } from "@/stores/catalog";
export const openDrama = (id: string) => {
  void Taro.navigateTo({ url: `/sub/catalog/detail/index?dramaId=${encodeURIComponent(id)}` });
};
export function DramaCards({
  items,
  horizontal = false,
  presentation,
}: {
  items: DramaCard[];
  horizontal?: boolean;
  presentation?: "mall";
}) {
  const mall = presentation === "mall";
  return (
    <View
      className={`catalog-cards${horizontal ? " catalog-cards--horizontal" : ""}${mall ? " catalog-cards--mall" : ""}`}
    >
      {items.map((item) => (
        <View
          className="catalog-cards__item"
          key={item.dramaId}
          onClick={() => openDrama(item.dramaId)}
        >
          <Cover
            title={item.title}
            src={item.posterUrl?.url}
            variant={horizontal ? "scroll" : "grid"}
            caption={
              mall ? item.genres.map((genre) => genre.name).join(" · ") : `${item.totalEpisodes} 集`
            }
            badge={item.badge === "new" ? "新上架" : item.badge === "hot" ? "推荐" : undefined}
            badgeTone={mall ? (item.badge === "new" ? "info" : "warning") : undefined}
          />
          <View className="catalog-cards__title">{item.title}</View>
          <View className="catalog-cards__meta">
            {mall
              ? `${item.totalEpisodes} 集${item.heatTier ? ` · 选用量 ${item.heatTier}` : ""}`
              : item.genres.map((genre) => genre.name).join(" · ")}
          </View>
          <View className="catalog-cards__price">
            {!mall && "discountedPoints" in item && item.discountedPoints !== null
              ? `${formatInteger(item.discountedPoints)} 积分`
              : item.listPricePoints !== null
                ? `${formatInteger(item.listPricePoints)} 积分`
                : "暂无报价"}
          </View>
          {mall && "discountedPoints" in item ? (
            <View className="catalog-cards__deduction">
              {item.discountedPoints === null
                ? "暂无实扣报价"
                : `实扣 ${formatInteger(item.discountedPoints)} 积分`}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
