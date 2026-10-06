import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { orderApi } from "../private/api";
import { useOrderResource } from "../private/resource";
export function OrderResult({ id }: { id: string }) {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <Result key={`${id}:${rev}:${token}`} id={id} />;
}
function Result({ id }: { id: string }) {
  const resource = useOrderResource(() => orderApi.detail(id), id),
    order = resource.data;
  return (
    <View id={resource.loading ? undefined : "order-ready"}>
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!order && resource.loading ? (
          <Skeleton />
        ) : !order ? (
          <Empty title="暂无订购结果" />
        ) : (
          <>
            <Card title="订购成功">
              <Note>订单已受理，可在订单详情查看交付进度</Note>
            </Card>
            <Card title="订单信息">
              <DescList
                items={[
                  { label: "订单号", value: order.orderNo },
                  { label: "订购剧目", value: `${order.itemCount} 部` },
                  { label: "订购积分", value: `${formatInteger(order.totalChargePoints)} 积分` },
                ]}
              />
            </Card>
            <Button
              block
              onClick={() => {
                void Taro.redirectTo({
                  url: `/sub/order/order-detail/index?orderId=${encodeURIComponent(order.orderId)}`,
                });
              }}
            >
              查看订单
            </Button>
            <Button
              block
              variant="outline"
              onClick={() => {
                void Taro.switchTab({ url: "/pages/mall/index" });
              }}
            >
              继续选剧
            </Button>
          </>
        )}
      </PageBody>
    </View>
  );
}
