import { View } from "@tarojs/components";
import { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Section } from "@/components/Section";
import { Timeline } from "@/components/Timeline";
import { deliveryApi as api } from "../components/delivery-runtime";
import { readLaunchRecord } from "./model";
import { useDeliveryResource } from "../components/resource";
import {
  DeliveryEmpty,
  DeliveryState,
  DeliveryStatus,
  useDeliveryIdentity,
} from "../components/ui";
const events: Record<string, string> = {
  created: "创建发布任务",
  submitted: "回填上线链接",
  passed: "核验通过",
  passed_partial: "部分集数核验通过",
  returned: "退回补充",
  revoked: "撤销核验",
  withdrawn: "撤回",
  voided: "任务作废",
};
export default function LaunchRecordPage() {
  const identity = useDeliveryIdentity(),
    id = useRouter().params.orderItemId ?? "";
  return <RecordContent key={`${identity}:${id}`} id={id} />;
}
function RecordContent({ id }: { id: string }) {
  const r = useDeliveryResource((current) => {
    if (!id) throw new Error("缺少订单项编号，请从订单详情打开");
    return readLaunchRecord(api, id, current);
  });
  return (
    <View className="delivery-page" id={!r.loading ? "delivery-ready" : undefined}>
      <PageBody>
        <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
        {r.data?.map((detail) => (
          <Section
            key={detail.task.launchTaskId}
            title={detail.task.channelAccount.accountName}
            extra={
              <DeliveryStatus column="launch_task.review_status" value={detail.task.reviewStatus} />
            }
          >
            <Card title={detail.task.platform === "douyin" ? "抖音发布记录" : "视频号发布记录"}>
              <DescList
                labelWidth="lg"
                items={[
                  { label: "账号", value: detail.task.channelAccount.accountUid },
                  { label: "上线状态", value: detail.task.isLive ? "已上线" : "未上线" },
                  { label: "已核验集数", value: `${detail.task.verifiedEpisodeCount} 集` },
                  { label: "首上线日期", value: detail.task.firstLaunchDate ?? "—" },
                ]}
              />
              {detail.launch ? (
                <View className="delivery-stack delivery-separator">
                  <DescList
                    labelWidth="lg"
                    items={[
                      { label: "已发布集数", value: `${detail.launch.reportedEpisodeCount} 集` },
                      { label: "实际上线日", value: detail.launch.actualLaunchDate },
                      { label: "核验人", value: detail.launch.verifiedByName ?? "待核验" },
                    ]}
                  />
                  <View className="delivery-link">
                    {detail.launch.collectionUrl ??
                      detail.launch.episodeUrls
                        .map((v) => `第 ${v.episodeNo} 集：${v.url}`)
                        .join("\n")}
                  </View>
                </View>
              ) : (
                <Note>暂未回填上线链接。</Note>
              )}
              {detail.task.returnInfo ? (
                <Note>
                  {detail.task.returnInfo.reasons.map((v) => v.name).join("、")}{" "}
                  {detail.task.returnInfo.note}
                </Note>
              ) : null}
            </Card>
            <Card title="核验结论">
              {detail.verifyChecks.length ? (
                <DescList
                  items={detail.verifyChecks.map((v) => ({
                    label: v.label,
                    value: `${v.result === "pass" ? "通过" : v.result === "fail" ? "未通过" : "不适用"}${v.note ? ` · ${v.note}` : ""}`,
                  }))}
                />
              ) : (
                <View className="delivery-caption">暂无核验结果</View>
              )}
            </Card>
            <Card title="处理记录">
              <Timeline
                variant="record"
                items={[...detail.timeline].reverse().map((v) => ({
                  key: `${v.kind}:${v.at}:${v.roundNo}`,
                  title: events[v.kind] ?? v.kind,
                  time: appDateTimeFormat.dateTime(v.at),
                  description: [
                    v.reportedEpisodeCount !== null ? `声明 ${v.reportedEpisodeCount} 集` : "",
                    v.verifiedEpisodeCount !== null ? `核验 ${v.verifiedEpisodeCount} 集` : "",
                    v.reasons.map((reason) => reason.name).join("、"),
                    v.note ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }))}
              />
            </Card>
          </Section>
        ))}
        {r.data && !r.data.length ? <DeliveryEmpty text="暂无上线记录" /> : null}
        {r.data ? (
          <Section title="巡检记录">
            <Card>
              <View className="delivery-caption">暂无巡检记录</View>
            </Card>
          </Section>
        ) : null}
      </PageBody>
    </View>
  );
}
