import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { DescList } from "@/components/DescList";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Section } from "@/components/Section";
import { Sheet } from "@/components/Sheet";
import { flagOn, useBootstrapStore } from "@/stores/bootstrap";
import { deliveryRequest } from "../components/delivery-runtime";
import { createSampleApi } from "./api";
import { sampleConfirmation, sampleIdentity, samplePlaybackBlocker } from "./model";
import { SamplePlayer } from "./player";
import { useDeliveryResource } from "../components/resource";
import {
  DeliveryEmpty,
  DeliveryState,
  DeliveryStatus,
  useDeliveryIdentity,
} from "../components/ui";
const api = createSampleApi(deliveryRequest);
export default function SamplePage() {
  const identity = useDeliveryIdentity(),
    id = useRouter().params.orderItemId ?? "";
  return <SampleContent key={`${identity}:${id}`} id={id} />;
}
function SampleContent({ id }: { id: string }) {
  const r = useDeliveryResource(() => {
    if (!id) throw new Error("缺少订单项编号，请从订单详情打开");
    return api.sample(id);
  });
  const [review, setReview] = useState({ key: "", acknowledged: false, confirm: false });
  const s = r.data;
  const version = s ? sampleIdentity(s) : null;
  useBootstrapStore((v) => v.data.flags);
  const enabled = flagOn("weapp.video.sample.enabled"),
    blocker = samplePlaybackBlocker(s, enabled),
    canView = !blocker && Boolean(s?.confirmableVia.includes("weapp")),
    canConfirm = Boolean(s?.actions.includes("confirm"));
  const reviewKey = `${version ?? ""}:${canView}`;
  if (review.key !== reviewKey) setReview({ key: reviewKey, acknowledged: false, confirm: false });
  const checked = review.key === reviewKey && review.acknowledged,
    confirm = review.key === reviewKey && review.confirm;
  const decide = () =>
    r.run("sample_confirm", async (current) => {
      if (!s) return;
      const body = sampleConfirmation(s, checked, flagOn("weapp.video.sample.enabled"));
      await api.confirmSample(
        s.sampleId,
        body,
        r.intent("sampleConfirm", { sample: s.sampleId, body }),
      );
      if (!current()) return;
      r.replace(await api.sample(id), current);
      if (current()) {
        setReview({ key: reviewKey, acknowledged: false, confirm: false });
        void Taro.showToast({ title: "样片已确认", icon: "none" });
      }
    });
  return (
    <View className="delivery-page" id={!r.loading ? "delivery-ready" : undefined}>
      <PageBody>
        <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
        {s ? (
          <>
            <Card
              title={s.dramaTitle}
              extra={<DeliveryStatus column="sample.status" value={s.status} />}
            >
              <DescList
                items={[
                  { label: "当前样片", value: `第 ${s.versionNo} 版` },
                  {
                    label: "时长",
                    value: `${Math.floor(s.durationMs / 60000)} 分 ${Math.floor(s.durationMs / 1000) % 60} 秒`,
                  },
                  { label: "推送时间", value: appDateTimeFormat.dateTime(s.pushedAt) },
                ]}
              />
              {!blocker ? (
                <SamplePlayer
                  key={version}
                  sample={s}
                  blocked={confirm || r.busy}
                  reload={() => api.sample(id)}
                  replace={r.replace}
                />
              ) : (
                <Note>{blocker}</Note>
              )}
            </Card>
            {!blocker ? <Note>请在小程序内查看当前版本样片，确认前勾选“我已查看”。</Note> : null}
            <Button size="sm" variant="secondary" disabled={r.busy} onClick={r.refresh}>
              刷新样片
            </Button>
            <Section title="质检摘要">
              <Card>
                <DescList
                  items={s.qcSummary.map((v) => ({
                    label: v.label,
                    value: `${v.result === "pass" ? "通过" : v.result === "fail" ? "未通过" : "不适用"}${v.note ? ` · ${v.note}` : ""}`,
                  }))}
                />
              </Card>
            </Section>
            {canConfirm ? (
              <Card>
                <Checkbox
                  checked={checked}
                  disabled={!canView || r.busy}
                  onChange={(v) => setReview({ key: reviewKey, acknowledged: v, confirm: false })}
                >
                  我已查看第 {s.versionNo} 版样片
                </Checkbox>
                <View className="delivery-caption">
                  {canView
                    ? "请确认已查看当前版本的完整样片"
                    : (blocker ?? "当前样片不可确认，请刷新或联系服务经理")}
                </View>
              </Card>
            ) : null}
            {s.decision ? (
              <Note>已于 {appDateTimeFormat.dateTime(s.decision.decidedAt)} 处理此版本。</Note>
            ) : null}
            {s.isPaused ? <Note>制作已暂停，请联系服务经理。</Note> : null}
            {canConfirm ? (
              <FooterBar>
                <Button
                  block
                  disabled={!checked || !canView || r.busy}
                  onClick={() => setReview({ ...review, confirm: true })}
                >
                  确认样片
                </Button>
              </FooterBar>
            ) : null}
            <Sheet
              visible={confirm}
              title="确认样片"
              description={`确认已查看第 ${s.versionNo} 版样片`}
              onClose={() => {
                if (!r.busy) setReview({ ...review, confirm: false });
              }}
              closeOnOverlayClick={!r.busy}
              footer={
                <Button block disabled={!checked || !canView} loading={r.busy} onClick={decide}>
                  确认样片
                </Button>
              }
            >
              <Note>确认后将继续制作成片。</Note>
            </Sheet>
          </>
        ) : !r.loading && !r.error ? (
          <DeliveryEmpty text="暂未推送样片，请等待服务经理" />
        ) : null}
      </PageBody>
    </View>
  );
}
