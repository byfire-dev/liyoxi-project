import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { Field } from "@/components/Field";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { Section } from "@/components/Section";
import { Sheet } from "@/components/Sheet";
import { TextArea } from "@/components/TextArea";
import type { Change } from "../components/delivery-api";
import { deliveryRequest } from "../components/delivery-runtime";
import { createPlanApi } from "./api";
import { changeBody, changeKinds } from "./model";
import { useDeliveryResource } from "../components/resource";
import {
  DeliveryEmpty,
  DeliveryState,
  DeliveryStatus,
  useDeliveryIdentity,
} from "../components/ui";
const api = createPlanApi(deliveryRequest);
export default function PlanPage() {
  const identity = useDeliveryIdentity(),
    id = useRouter().params.deliveryPlanId ?? "";
  return <PlanContent key={`${identity}:${id}`} id={id} />;
}
function PlanContent({ id }: { id: string }) {
  const r = useDeliveryResource(() => {
    if (!id) throw new Error("缺少方案编号，请从订单详情打开");
    return api.plan(id);
  });
  const [sheet, setSheet] = useState<"confirm" | "change" | null>(null),
    [kinds, setKinds] = useState<Change["kinds"]>([]),
    [note, setNote] = useState("");
  const p = r.data;
  const write = () =>
    r.run(sheet === "confirm" ? "plan_confirm" : null, async (current) => {
      if (!p?.version) return;
      if (sheet === "confirm")
        await api.confirmPlan(
          id,
          p.version.versionNo,
          r.intent("planConfirm", { id, version: p.version.versionNo }),
        );
      else {
        const body = changeBody(kinds, note);
        await api.changePlan(
          id,
          body,
          r.intent("planChange", { id, version: p.version.versionNo, body }),
        );
      }
      if (!current()) return;
      const fresh = await api.plan(id);
      r.replace(fresh, current);
      if (current()) {
        setSheet(null);
        setKinds([]);
        setNote("");
        void Taro.showToast({ title: "已提交", icon: "none" });
      }
    });
  return (
    <View className="delivery-page" id={p ? "delivery-ready" : undefined}>
      <PageBodyLocal>
        <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
        {p ? (
          <>
            <Card
              variant="dark"
              eyebrow={p.orderNo}
              title="确认交付方案"
              extra={<DeliveryStatus column="delivery_plan.status" value={p.status} />}
            >
              <View>
                {p.version
                  ? `第 ${p.version.versionNo} 版 · ${p.itemCount} 部短剧，共 ${p.totalEpisodes} 集`
                  : "方案制作中"}
              </View>
              <View className="delivery-caption">
                服务经理：{p.deliveryManagerName ?? "待分配"}
              </View>
            </Card>
            {p.openChange ? (
              <Note>服务经理正在修改方案：{p.openChange.notes.join("；")}</Note>
            ) : null}
            {p.isOrderInAfterSale ? <Note>订单售后处理中，暂不能确认方案。</Note> : null}
            {p.content ? (
              <>
                <Section title="定制重点">
                  <Card>
                    <View className="delivery-chips">
                      {p.content.focusTags.map((v) => (
                        <Chip key={v}>{v}</Chip>
                      ))}
                    </View>
                    <View className="delivery-caption">
                      {p.content.note ?? "按已确认的门店资料制作"}
                    </View>
                  </Card>
                </Section>
                <Section title="短剧与发布安排">
                  {p.content.items.map((item) => (
                    <Card key={item.orderItemId} title={item.dramaTitle}>
                      <View className="delivery-row">
                        <View className="delivery-cover">
                          <Cover title={item.dramaTitle} src={item.posterUrl?.url} />
                        </View>
                        <DescList
                          items={[
                            { label: "集数", value: `${item.episodeCount} 集` },
                            { label: "上线日期", value: item.agreedLaunchDate },
                            { label: "预计交付", value: item.expectedDeliveryDate ?? "待确认" },
                            { label: "使用截止", value: item.usageEndDate },
                          ]}
                        />
                      </View>
                      <View className="delivery-separator">
                        {item.accounts.map((a) => (
                          <View key={a.channelAccountId} className="delivery-caption">
                            {a.accountName} · {a.platform}
                          </View>
                        ))}
                      </View>
                    </Card>
                  ))}
                </Section>
                <Section title="参考资料">
                  <Card>
                    <View>
                      {p.content.referenceAssets.map((a) => a.title ?? "参考素材").join("、") ||
                        "暂无参考素材"}
                    </View>
                    <View className="delivery-caption">
                      门店图片与视频 {p.content.profileMedia.length} 份，按当前资料制作。
                    </View>
                  </Card>
                </Section>
              </>
            ) : (
              <DeliveryEmpty text="方案尚未推送，请等待服务经理" />
            )}
            <Section title="广告">
              <Card>暂无</Card>
            </Section>
            {p.confirmedAt ? (
              <Note>
                已于 {appDateTimeFormat.dateTime(p.confirmedAt)} 确认第 {p.confirmedVersionNo}{" "}
                版方案。
              </Note>
            ) : null}
            {p.actions.length ? (
              <FooterBar>
                {p.actions.includes("request-change") ? (
                  <Button variant="secondary" disabled={r.busy} onClick={() => setSheet("change")}>
                    联系服务经理修改
                  </Button>
                ) : null}
                {p.actions.includes("confirm") ? (
                  <Button disabled={r.busy || !p.version} onClick={() => setSheet("confirm")}>
                    确认方案
                  </Button>
                ) : null}
              </FooterBar>
            ) : null}
            <Sheet
              visible={sheet !== null}
              title={sheet === "confirm" ? "确认交付方案" : "联系服务经理修改"}
              description={
                sheet === "confirm"
                  ? `确认当前看到的第 ${p.version?.versionNo ?? "—"} 版方案`
                  : "请选择需要修改的内容"
              }
              onClose={() => {
                if (!r.busy) setSheet(null);
              }}
              closeOnOverlayClick={!r.busy}
              footer={
                <Button block loading={r.busy} onClick={write}>
                  {sheet === "confirm" ? "确认方案" : "提交修改说明"}
                </Button>
              }
            >
              {sheet === "change" ? (
                <View className="delivery-stack">
                  <Field label="修改项" required>
                    <View className="delivery-chips">
                      {changeKinds.map(([key, label]) => (
                        <Chip
                          key={key}
                          selected={kinds.includes(key)}
                          disabled={r.busy}
                          onClick={() =>
                            setKinds((v) =>
                              v.includes(key) ? v.filter((k) => k !== key) : [...v, key],
                            )
                          }
                        >
                          {label}
                        </Chip>
                      ))}
                    </View>
                  </Field>
                  <Field label="修改说明" required>
                    <TextArea
                      value={note}
                      maxLength={200}
                      disabled={r.busy}
                      placeholder="请说明需要调整的内容"
                      onChange={setNote}
                    />
                  </Field>
                </View>
              ) : (
                <Note>确认后将按此方案继续制作。</Note>
              )}
            </Sheet>
          </>
        ) : null}
      </PageBodyLocal>
    </View>
  );
}
import { PageBody as PageBodyLocal } from "@/components/PageBody";
