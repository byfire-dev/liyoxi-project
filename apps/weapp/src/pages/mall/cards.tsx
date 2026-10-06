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
}: {
  items: DramaCard[];
  horizontal?: boolean;
}) {
  return (
    <View className={horizontal ? "catalog-cards catalog-cards--horizontal" : "catalog-cards"}>
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
            caption={`${item.totalEpisodes} 集`}
            badge={item.badge === "new" ? "新上架" : item.badge === "hot" ? "推荐" : undefined}
          />
          <View className="catalog-cards__title">{item.title}</View>
          <View className="catalog-cards__meta">{item.genres.map((g) => g.name).join(" · ")}</View>
          <View className="catalog-cards__price">
            {"discountedPoints" in item && item.discountedPoints !== null
              ? `${formatInteger(item.discountedPoints)} 积分`
              : item.listPricePoints !== null
                ? `${formatInteger(item.listPricePoints)} 积分`
                : "暂无报价"}
          </View>
        </View>
      ))}
    </View>
  );
}
