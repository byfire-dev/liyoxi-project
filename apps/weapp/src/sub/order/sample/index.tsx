import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Section } from "@/components/Section";
import { Sheet } from "@/components/Sheet";
import { flagOn, useBootstrapStore } from "@/stores/bootstrap";
import { withPrivacy } from "@/lib/runtime";
import { saveVideoUrl } from "@/lib/platform.taro";
import { deliveryApi as api } from "../components/delivery-runtime";
import { saveSample, sampleConfirmation } from "./model";
import { useDeliveryResource } from "../components/resource";
import {
  DeliveryEmpty,
  DeliveryState,
  DeliveryStatus,
  useDeliveryIdentity,
} from "../components/ui";
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
  const [acknowledged, setAcknowledged] = useState<string | null>(null),
    [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  const s = r.data;
  const version = s ? `${s.sampleId}:${s.versionNo}` : null;
  const checked = Boolean(version && acknowledged === version),
    confirm = Boolean(version && confirmVersion === version);
  useBootstrapStore((v) => v.data.flags);
  const albumOffered = Boolean(
    s?.previewChannels.includes("album") ||
    (s?.previewChannels.includes("weapp") && !flagOn("weapp.video.sample.enabled")),
  );
  const save = () =>
    r.run(null, async (current) => {
      if (!s) return;
      const result = await withPrivacy(async () => {
        if (!current()) return;
        return saveSample(api, s, saveVideoUrl, current);
      });
      if (!current()) return;
      if (!result.ok) throw new Error("请同意隐私指引后再保存样片");
      if (result.value) r.replace(result.value, current);
      if (current()) void Taro.showToast({ title: "已保存，请到相册查看", icon: "none" });
    });
  const decide = () =>
    r.run("sample_confirm", async (current) => {
      if (!s) return;
      const body = sampleConfirmation(s, checked);
      await api.confirmSample(
        s.sampleId,
        body,
        r.intent("sampleConfirm", { sample: s.sampleId, body }),
      );
      if (!current()) return;
      r.replace(await api.sample(id), current);
      if (current()) {
        setConfirmVersion(null);
        setAcknowledged(null);
        void Taro.showToast({ title: "样片已确认", icon: "none" });
      }
    });
  const canView = Boolean(s?.confirmableVia.length),
    canConfirm = Boolean(s?.actions.includes("confirm"));
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
              <View className="delivery-row">
                <View className="delivery-cover">
                  <Cover title={s.dramaTitle} />
                </View>
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
              </View>
            </Card>
            <Note>样片不在小程序内播放。请保存到相册，查看完整内容后确认。</Note>
            <Button size="sm" variant="secondary" disabled={r.busy} onClick={r.refresh}>
              刷新样片
            </Button>
            <Button
              block
              variant="outline"
              loading={r.busy}
              disabled={!albumOffered}
              onClick={save}
            >
              保存样片到相册查看
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
                  onChange={(v) => setAcknowledged(v ? version : null)}
                >
                  我已查看第 {s.versionNo} 版样片
                </Checkbox>
                <View className="delivery-caption">
                  {canView ? "请确认已查看当前版本的完整样片" : "请先保存样片到相册查看"}
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
                  onClick={() => setConfirmVersion(version)}
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
                if (!r.busy) setConfirmVersion(null);
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
