import { useLayoutEffect, useRef, useState } from "react";
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
import { TextButton } from "@/components/TextButton";
import { actualAdUrl } from "../private/m5-order";
import { SampleFeedbackForm } from "./feedback-form";
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
  const [review, setReview] = useState({
    key: "",
    acknowledged: false,
    confirm: false,
    feedback: false,
  });
  const s = r.data;
  const latestSample = useRef(s);
  useLayoutEffect(() => {
    latestSample.current = s;
  }, [s]);
  const version = s ? sampleIdentity(s) : null;
  useBootstrapStore((v) => v.data.flags);
  const enabled = flagOn("weapp.video.sample.enabled"),
    blocker = samplePlaybackBlocker(s, enabled),
    canView = !blocker && Boolean(s?.confirmableVia.includes("weapp")),
    canConfirm = Boolean(s?.actions.includes("confirm"));
  const reviewKey = `${version ?? ""}:${canView}`;
  if (review.key !== reviewKey)
    setReview({ key: reviewKey, acknowledged: false, confirm: false, feedback: false });
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
        setReview({ key: reviewKey, acknowledged: false, confirm: false, feedback: false });
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
                  blocked={confirm || review.feedback || r.busy}
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
            {s.actions.includes("request-change") && !blocker ? (
              <Button
                variant="outline"
                disabled={r.busy}
                onClick={() => setReview({ ...review, confirm: false, feedback: true })}
              >
                提出合成修改
              </Button>
            ) : null}
            {s.adsUsed.length ? (
              <Card title="关联广告">
                {s.adsUsed.map((ad) => {
                  const url = actualAdUrl(ad.adId);
                  return (
                    <View key={`${ad.slot}:${ad.adId}`}>
                      <Note>
                        {ad.slot === "opening" ? "片头" : "片尾"}广告 · 第 {ad.versionNo} 版
                      </Note>
                      {url ? (
                        <TextButton
                          onClick={() => {
                            void Taro.navigateTo({ url });
                          }}
                        >
                          查看广告并提出内容修改
                        </TextButton>
                      ) : (
                        <Note>广告内容调整请联系服务经理。</Note>
                      )}
                    </View>
                  );
                })}
              </Card>
            ) : null}
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
                  onChange={(v) =>
                    setReview({ key: reviewKey, acknowledged: v, confirm: false, feedback: false })
                  }
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
            {s.decision?.feedbackNote ? (
              <Card title="已提交的合成修改">
                <Note>{s.decision.feedbackNote}</Note>
                {s.decision.feedbackImages.map((image) => (
                  <TextButton
                    key={image.fileId}
                    onClick={() => {
                      void Taro.previewImage({
                        urls: s.decision!.feedbackImages.map((value) => value.url),
                        current: image.url,
                      });
                    }}
                  >
                    查看修改截图
                  </TextButton>
                ))}
              </Card>
            ) : null}
            {!blocker && s.actions.includes("request-change") ? (
              <SampleFeedbackForm
                key={`${reviewKey}:${s.status}`}
                sample={s}
                itemId={id}
                currentSample={() => latestSample.current}
                resource={r}
                api={api}
                visible={review.feedback}
                onClose={() => setReview({ ...review, feedback: false })}
              />
            ) : null}
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
