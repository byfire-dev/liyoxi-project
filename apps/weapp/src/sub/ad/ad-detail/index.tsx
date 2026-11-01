import { useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { DescList } from "@/components/DescList";
import { FooterBar } from "@/components/FooterBar";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { withPrivacy } from "@/lib/runtime";
import { saveVideoUrl } from "@/lib/platform.taro";
import { flagOn, useBootstrapStore } from "@/stores/bootstrap";
import { useDeliveryIdentity } from "../../order/components/ui";
import { adApi } from "../private/api";
import { adIdentity, assertSameVersion, channelNames, confirmBody } from "../private/model";
import { useAdResource } from "../private/resource";
import { AdPlayer } from "../private/player";
import { AdChangeForm, AdResubmitForm } from "../private/detail-forms";
import "../private/ad.scss";

export default function AdDetailPage() {
  const identity = useDeliveryIdentity(),
    id = useRouter().params.adId ?? "";
  return <AdDetail key={`${identity}:${id}`} id={id} />;
}
function AdDetail({ id }: { id: string }) {
  const r = useAdResource(() => {
    if (!id) throw new Error("缺少广告编号，请从广告列表打开");
    return adApi.get(id);
  });
  const [review, setReview] = useState({ key: "", checked: false, confirm: false, form: "" });
  const ad = r.data;
  useBootstrapStore((state) => state.data.flags);
  const enabled = flagOn("weapp.video.ad.enabled"),
    key = ad ? `${adIdentity(ad)}:${enabled}:${ad.confirmableVia.join(",")}` : "";
  if (review.key !== key) setReview({ key, checked: false, confirm: false, form: "" });
  const status = ad ? merchantStatusByEnum("ad.status", ad.status) : null;
  return (
    <View className="ad-page" id={!r.loading ? "ad-ready" : undefined}>
      <PageBody>
        {r.error ? <LoadError message={r.error} onRetry={r.refresh} /> : null}
        {r.loading ? (
          <Skeleton cards={3} />
        ) : ad ? (
          <>
            <Card
              title={`${ad.type === "opening" ? "片头" : "片尾"}贴片 · ${ad.durationSec}秒`}
              extra={status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : undefined}
            >
              <Note>{ad.copy ?? ad.promoPoints.map((point) => point.name).join("、")}</Note>
              <DescList
                items={[
                  { label: "广告编号", value: ad.adNo },
                  { label: "剩余免费修改", value: `${ad.freeRevisionsRemaining}次` },
                  {
                    label: ad.isCaptured ? "已扣积分" : "冻结积分",
                    value: `${ad.chargePoints}积分`,
                  },
                  {
                    label: "本轮截止",
                    value: ad.dueAt ? appDateTimeFormat.dateTime(ad.dueAt) : "—",
                  },
                  { label: "制作人员", value: ad.editorName ?? "待指派" },
                ]}
              />
              {ad.waitingReason === "materials" ? (
                <Note tone="warning">请补充素材：{ad.returnReason}</Note>
              ) : ad.waitingReason === "qualification" ? (
                <Note>门店资质审核中，审核通过后开始制作。</Note>
              ) : null}
              {ad.hasOpenCancelRequest ? <Note>取消申请处理中，当前不可确认或修改。</Note> : null}
            </Card>
            {ad.currentVersion ? (
              <Card title={`当前第${ad.currentVersion.versionNo}版广告`}>
                {enabled &&
                ad.currentVersion.previewChannels.includes("weapp") &&
                ad.playable?.sources.length ? (
                  <AdPlayer
                    key={adIdentity(ad)}
                    ad={ad}
                    blocked={r.busy || review.confirm || !!review.form}
                    replace={r.replace}
                  />
                ) : (
                  <Note>
                    请按本版允许的方式查看：
                    {ad.currentVersion.previewChannels
                      .map((via) => channelNames[via] ?? via)
                      .join("、")}
                  </Note>
                )}
                <DescList
                  items={[
                    {
                      label: "相册记录",
                      value: ad.viewEvidence.albumSavedAt
                        ? appDateTimeFormat.dateTime(ad.viewEvidence.albumSavedAt)
                        : "暂无本版记录",
                    },
                    {
                      label: "电脑预览记录",
                      value: ad.viewEvidence.portalViewedAt
                        ? appDateTimeFormat.dateTime(ad.viewEvidence.portalViewedAt)
                        : "暂无本版记录",
                    },
                    {
                      label: "企业微信",
                      value: ad.alternatives.isOfflineSent ? "服务经理已登记发送" : "尚未登记发送",
                    },
                  ]}
                />
                {ad.alternatives.canSaveToAlbum ? (
                  <Button
                    variant="secondary"
                    loading={r.busy}
                    onClick={() =>
                      r.run(async (current) => {
                        const fresh = await adApi.get(id);
                        if (!current()) return;
                        r.replace(fresh, current);
                        assertSameVersion(ad, fresh);
                        if (!fresh.alternatives.canSaveToAlbum || !fresh.currentVersion)
                          throw new Error("当前版本不可保存相册");
                        const allowed = await withPrivacy(async () => {
                          const download = await adApi.download(
                            id,
                            fresh.currentVersion!.versionNo,
                          );
                          if (!current()) return;
                          await saveVideoUrl(download.url);
                        });
                        if (!allowed.ok) throw new Error("请先同意隐私指引，再保存广告");
                        if (!current()) return;
                        r.replace(await adApi.get(id), current);
                        if (process.env.TARO_ENV === "weapp" && current())
                          void Taro.showToast({ title: "已保存到相册", icon: "none" });
                      })
                    }
                  >
                    保存当前版到相册查看
                  </Button>
                ) : null}
                {ad.alternatives.canPreviewOnPortal ? (
                  <Note>电脑端查看将在下载页提供；本页只展示已有的真实预览记录。</Note>
                ) : null}
                <Button size="sm" variant="outline" disabled={r.busy} onClick={r.refresh}>
                  刷新广告与查看证据
                </Button>
              </Card>
            ) : (
              <Card>
                <Note>当前尚未推送广告版本，请等待服务经理。</Note>
              </Card>
            )}
            {ad.actions.includes("confirm") ? (
              <Card>
                <Checkbox
                  checked={review.checked}
                  disabled={r.busy || !ad.confirmableVia.length}
                  onChange={(checked) => setReview({ ...review, checked, confirm: false })}
                >
                  我已查看第{ad.currentVersionNo}版广告
                </Checkbox>
                <Note>
                  {ad.confirmableVia.length
                    ? `本次确认方式：${channelNames[ad.confirmableVia[0]!] ?? ad.confirmableVia[0]}`
                    : "尚无满足确认要求的本版查看证据，请先查看后刷新。"}
                </Note>
              </Card>
            ) : null}
            {ad.actions.includes("request-change") ? (
              <Button
                variant="outline"
                disabled={r.busy}
                onClick={() => setReview({ ...review, form: "change" })}
              >
                提出广告修改
              </Button>
            ) : null}
            {ad.actions.includes("submit") ? (
              <Button disabled={r.busy} onClick={() => setReview({ ...review, form: "resubmit" })}>
                补充后重新提交
              </Button>
            ) : null}
            {ad.references.length ? (
              <Card title="本次参考素材">
                {ad.references.map((ref, n) => (
                  <Note key={`${ref.storeAssetId ?? ref.fileId}:${n}`}>
                    {ref.title ?? ref.mediaGroup ?? ref.category ?? "参考素材"}
                  </Note>
                ))}
              </Card>
            ) : null}
            {ad.floatingPlacements.length ? (
              <Card title="关联订单">
                {ad.floatingPlacements.map((item) => (
                  <TextButton
                    key={`${item.orderItemId}:${item.slot}`}
                    onClick={() =>
                      void Taro.navigateTo({
                        url: `/sub/order/order-detail/index?orderId=${encodeURIComponent(item.orderId)}`,
                      })
                    }
                  >
                    {item.dramaTitle} · {item.orderNo}
                    {item.isTicketPaused ? " · 已暂停" : ""}
                  </TextButton>
                ))}
              </Card>
            ) : null}
            {ad.versions.length ? (
              <Card title="版本记录">
                {ad.versions.map((version) => (
                  <DescList
                    key={version.versionNo}
                    items={[
                      {
                        label: `第${version.versionNo}版`,
                        value: appDateTimeFormat.dateTime(version.pushedAt),
                      },
                      {
                        label: "查看方式",
                        value: version.previewChannels
                          .map((via) => channelNames[via] ?? via)
                          .join("、"),
                      },
                      {
                        label: "处理结果",
                        value:
                          version.decision === "confirmed"
                            ? "已确认"
                            : version.decision === "revision_requested"
                              ? "已提修改"
                              : version.decision === "superseded"
                                ? "已被新版替代"
                                : "待处理",
                      },
                    ]}
                  />
                ))}
              </Card>
            ) : null}
            {ad.revisions.length ? (
              <Card title="修改记录">
                {ad.revisions.map((revision) => (
                  <View key={revision.revisionNo}>
                    <Note>
                      第{revision.revisionNo}轮 · 针对第{revision.onVersionNo}版 · {revision.note}
                    </Note>
                    <Note>
                      {revision.isChargeable ? `已扣${revision.chargePoints}积分` : "免费修改"}
                      {revision.fulfilledByVersionNo
                        ? ` · 第${revision.fulfilledByVersionNo}版已交付`
                        : " · 等待修改版"}
                    </Note>
                    {revision.screenshots.map((image) => (
                      <TextButton
                        key={image.fileId}
                        onClick={() =>
                          void Taro.previewImage({
                            urls: revision.screenshots.map((item) => item.url),
                            current: image.url,
                          })
                        }
                      >
                        查看修改截图
                      </TextButton>
                    ))}
                  </View>
                ))}
              </Card>
            ) : null}
            {ad.timeline.length ? (
              <Card title="进度记录">
                {ad.timeline.map((item, n) => (
                  <Note key={`${item.at}:${n}`}>
                    {appDateTimeFormat.dateTime(item.at)} · {item.title}
                    {item.detail ? `：${item.detail}` : ""}
                  </Note>
                ))}
              </Card>
            ) : null}
            {ad.actions.includes("confirm") ? (
              <FooterBar>
                <Button
                  block
                  disabled={!review.checked || !ad.confirmableVia.length || r.busy}
                  onClick={() => setReview({ ...review, confirm: true })}
                >
                  确认使用广告
                </Button>
              </FooterBar>
            ) : null}
            <Sheet
              visible={review.confirm}
              title={`确认使用第${ad.currentVersionNo}版广告`}
              onClose={() => {
                if (!r.busy) setReview({ ...review, confirm: false });
              }}
              closeOnOverlayClick={!r.busy}
              footer={
                <Button
                  block
                  loading={r.busy}
                  disabled={!review.checked}
                  onClick={() =>
                    r.run(async (current) => {
                      const fresh = await adApi.get(id);
                      if (!current()) return;
                      r.replace(fresh, current);
                      assertSameVersion(ad, fresh);
                      if (fresh.confirmableVia.join(",") !== ad.confirmableVia.join(","))
                        throw new Error("可确认的查看方式已变化，请重新核对并勾选");
                      const body = confirmBody(fresh, review.checked);
                      await adApi.confirm(id, body, r.intent("adConfirm", body));
                      if (!current()) return;
                      const actual = await adApi.get(id);
                      if (current()) {
                        r.replace(actual, current);
                        setReview({ key: "", checked: false, confirm: false, form: "" });
                      }
                    }, "ad_confirm")
                  }
                >
                  确认本版广告
                </Button>
              }
            >
              <Note>确认后可在后续订购中选用，本次不再扣积分。</Note>
              {r.error ? <Note tone="warning">{r.error}</Note> : null}
            </Sheet>
            {review.form === "change" ? (
              <AdChangeForm
                key={key}
                ad={ad}
                r={r}
                close={() => setReview({ ...review, form: "" })}
              />
            ) : review.form === "resubmit" ? (
              <AdResubmitForm
                key={key}
                ad={ad}
                r={r}
                close={() => setReview({ ...review, form: "" })}
              />
            ) : null}
          </>
        ) : null}
      </PageBody>
    </View>
  );
}
