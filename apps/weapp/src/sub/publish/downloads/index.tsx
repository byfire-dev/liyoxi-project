import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { saveVideoUrl } from "@/lib/platform.taro";
import { withPrivacy } from "@/lib/runtime";
import { deliveryRequest } from "../../order/components/delivery-runtime";
import { createReleaseApi } from "../components/release-api";
import { useDeliveryResource } from "../../order/components/resource";
import { DeliveryEmpty, DeliveryState, useDeliveryIdentity } from "../../order/components/ui";
const api = createReleaseApi(deliveryRequest);
export default function DownloadsPage() {
  const identity = useDeliveryIdentity(),
    id = useRouter().params.orderItemId ?? "";
  return <DownloadsContent key={`${identity}:${id}`} id={id} />;
}
function DownloadsContent({ id }: { id: string }) {
  const r = useDeliveryResource(() => {
    if (!id) throw new Error("缺少订单项编号，请从发布任务打开");
    return api.release(id);
  });
  const [episode, setEpisode] = useState<number | null>(null);
  const p = r.data;
  const save = (episodeNo: number) =>
    r.run("package_download", async (current) => {
      if (!p?.isDownloadable) return;
      setEpisode(episodeNo);
      const result = await withPrivacy(async () => {
        if (!current()) return;
        const signed = await api.episodeUrl(id, episodeNo);
        if (!current()) return;
        await saveVideoUrl(signed.url);
        if (current()) void Taro.showToast({ title: `第 ${episodeNo} 集已存到相册`, icon: "none" });
      });
      if (current() && !result.ok) throw new Error("请同意隐私指引后再存到相册");
      if (current()) setEpisode(null);
    });
  return (
    <View className="delivery-page" id={!r.loading ? "delivery-ready" : undefined}>
      <PageBody>
        <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
        {p ? (
          <>
            <Card variant="dark" title={`成片包 · 第 ${p.releaseNo} 版`}>
              <View>
                {p.episodeCount} 集 · {size(p.totalBytes)}
              </View>
              <View>推送于 {appDateTimeFormat.dateTime(p.pushedAt)}</View>
            </Card>
            {p.grant?.isExpired ? (
              <Note>下载授权已过期，请联系服务经理</Note>
            ) : !p.isDownloadable ? (
              <Note>当前成片暂不可下载，请联系服务经理。</Note>
            ) : (
              <Note>
                下载授权有效至 {p.grant ? appDateTimeFormat.dateTime(p.grant.expiresAt) : "—"}
                。每次存相册均重新签发地址，地址有效期 15 分钟。
              </Note>
            )}
            <Note>一次保存一集，不排队；保存后请到相册查看。真机保存效果待验证。</Note>
            {p.episodes.map((item) => (
              <Card
                key={item.episodeNo}
                title={`第 ${item.episodeNo} 集`}
                extra={item.isChanged ? "本版有更新" : undefined}
              >
                <View className="delivery-link">{item.fileName}</View>
                <View className="delivery-caption">{size(item.sizeBytes)}</View>
                <Button
                  block
                  variant="outline"
                  disabled={!p.isDownloadable || r.busy}
                  loading={r.busy && episode === item.episodeNo}
                  onClick={() => save(item.episodeNo)}
                >
                  存到相册
                </Button>
              </Card>
            ))}
          </>
        ) : !r.loading && !r.error ? (
          <DeliveryEmpty text="成片尚未交付，请等待服务经理" />
        ) : null}
      </PageBody>
    </View>
  );
}
function size(bytes: string) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}
