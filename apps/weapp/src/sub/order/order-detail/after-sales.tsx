import Taro from "@tarojs/taro";
import { View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Note } from "@/components/Note";
import { TextButton } from "@/components/TextButton";
import type { OrderDetail } from "@/stores/order";
const states: Record<string, string> = {
  pending_approval: "待审批",
  pending_execution: "待执行",
  done: "已执行",
  not_executed: "未执行",
};
const modes: Record<string, string> = {
  release: "释放冻结",
  refund: "退积分",
  terminate_only: "仅终止服务",
};
export function OrderAfterSales({ order }: { order: OrderDetail }) {
  return (
    <>
      <Card title="售后与取消进度">
        {order.afterSales.length ? (
          order.afterSales.map((request) => (
            <View key={request.cancelRequestId}>
              <DescList
                items={[
                  { label: "申请单", value: request.requestNo },
                  { label: "当前状态", value: states[request.status] ?? request.status },
                  ...(request.closeReason
                    ? [
                        {
                          label: "关闭原因",
                          value:
                            (
                              {
                                rejected: "审批未通过",
                                withdrawn: "已撤回",
                                voided: "已作废",
                              } as Record<string, string>
                            )[request.closeReason] ?? request.closeReason,
                        },
                      ]
                    : []),
                  { label: "提交时间", value: appDateTimeFormat.dateTime(request.submittedAt) },
                  {
                    label: "执行时间",
                    value: request.executedAt
                      ? appDateTimeFormat.dateTime(request.executedAt)
                      : "尚未执行",
                  },
                  { label: "申请积分", value: formatInteger(request.totalRefundPoints) },
                ]}
              />
              {request.lines.map((line) => (
                <View key={line.orderItemId}>
                  <Note>
                    {order.items.find((item) => item.orderItemId === line.orderItemId)
                      ?.dramaTitle ?? "关联剧目"}{" "}
                    · {modes[line.mode] ?? line.mode}
                  </Note>
                  <DescList
                    items={[
                      { label: "申请处理", value: `${formatInteger(line.refundPoints)} 积分` },
                      {
                        label: "已退回",
                        value:
                          line.returnedPoints === null
                            ? "待实际执行"
                            : `${formatInteger(line.returnedPoints)} 积分`,
                      },
                      {
                        label: "转加购",
                        value:
                          line.convertedPoints === null
                            ? "待实际执行"
                            : `${formatInteger(line.convertedPoints)} 积分`,
                      },
                      {
                        label: "已失效",
                        value:
                          line.forfeitedPoints === null
                            ? "待实际执行"
                            : `${formatInteger(line.forfeitedPoints)} 积分`,
                      },
                    ]}
                  />
                </View>
              ))}
              {request.status !== "done" ? (
                <Note>申请与审批不代表积分已退回，请以实际执行结果和积分记录为准。</Note>
              ) : null}
            </View>
          ))
        ) : (
          <Note>暂无售后申请</Note>
        )}
      </Card>
      <Card title="授权信息">
        {order.licenseLetters.length ? (
          order.licenseLetters.map((letter) => (
            <View key={letter.licenseLetterId}>
              <DescList
                items={[
                  { label: "授权书", value: letter.letterNo },
                  {
                    label: "剧目",
                    value:
                      order.items.find((item) => item.orderItemId === letter.orderItemId)
                        ?.dramaTitle ?? "关联剧目",
                  },
                  {
                    label: "发布账号",
                    value: `${letter.platform === "douyin" ? "抖音" : letter.platform === "wechat_channels" ? "视频号" : letter.platform} · ${letter.accountName}`,
                  },
                  {
                    label: "授权状态",
                    value:
                      letter.displayStatus === "effective"
                        ? "生效中"
                        : letter.displayStatus === "expired"
                          ? "已到期"
                          : "待生效",
                  },
                  {
                    label: "授权期间",
                    value: `${letter.periodStartDate ?? "上线首日"} 至 ${letter.periodEndDate}`,
                  },
                ]}
              />
            </View>
          ))
        ) : (
          <Note>暂无授权书，生成状态请在合同与授权书中查看。</Note>
        )}
        <TextButton
          onClick={() => {
            void Taro.navigateTo({
              url: `/sub/billing/contracts/index?orderId=${encodeURIComponent(order.orderId)}`,
            });
          }}
        >
          查看本订单合同与授权书
        </TextButton>
      </Card>
    </>
  );
}
