import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Pagination } from "antd";
import { useEffect, useRef, useState } from "react";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { InfoList } from "../../../components/InfoList";
import { ErrorState } from "../../../components/StateBlock";
import { canAction, type AccessSnapshot } from "../../../lib/permissions";
import { localStorageRequestUrl } from "../../../lib/local-storage";
import { actorScope } from "../../system/staff-access";
import type { M5Body, M5Ticket, M5TicketApi } from "./m5-api";
import { ticketActionError, type TicketAction } from "./m5-actions";

export function M5AdFacts({ ticket }: { ticket: M5Ticket }) {
  return (
    <div className="lyx-production-sections">
      {ticket.ads.length ? (
        ticket.ads.map((ad) => (
          <section className="lyx-production-card" key={`${ad.adId}:${ad.slot}`}>
            <h3>{ad.adNo}</h3>
            <InfoList
              items={[
                { label: "位置", value: ad.slot },
                {
                  label: "状态",
                  value: statusToneByEnum("ad.status", ad.status)?.admin?.label ?? ad.status,
                },
                {
                  label: "当前确认",
                  value:
                    ad.confirmedVersionNo === null ? "尚未确认" : `第 ${ad.confirmedVersionNo} 版`,
                },
                {
                  label: "绑定方式",
                  value:
                    ad.boundVersionNo === null
                      ? "跟随当前确认版"
                      : `固定第 ${ad.boundVersionNo} 版`,
                },
                { label: "广告文案", value: ad.copy ?? "暂无" },
                { label: "当前截止", value: ad.dueAt ? date.dateTime(ad.dueAt) : "暂无" },
              ]}
            />
          </section>
        ))
      ) : (
        <p>当前方案没有广告植入。</p>
      )}
    </div>
  );
}
export function M5Resources({
  ticket,
  api,
  access,
  onAction,
}: {
  ticket: M5Ticket;
  api: M5TicketApi;
  access: AccessSnapshot | null;
  onAction(action: TicketAction, productionId: string): void;
}) {
  const scope = actorScope(access),
    live = useRef(new AbortController()),
    signing = useRef(false);
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [signed, setSigned] = useState<Awaited<ReturnType<M5TicketApi["materialDownload"]>>["items"]>(
      [],
    );
  useEffect(() => {
    live.current = new AbortController();
    return () => live.current.abort();
  }, []);
  const materials = useQuery({
    queryKey: ["delivery", "m5-materials", scope, ticket.deliveryTicketId],
    queryFn: ({ signal }) => api.materials(ticket.deliveryTicketId, signal),
  });
  const production = useQuery({
    queryKey: ["delivery", "m5-production", scope, ticket.orderItem.orderItemId, page],
    queryFn: ({ signal }) => api.production(ticket.orderItem.orderItemId, signal, page),
  });
  const take = async (body: M5Body<"admin.deliveryTicket.material.downloadUrls">) => {
    if (signing.current || !canAction(access, "delivery.download")) return;
    signing.current = true;
    setBusy(true);
    setError(undefined);
    setSigned([]);
    try {
      await api.get(ticket.deliveryTicketId, live.current.signal);
      const result = await api.materialDownload(ticket.deliveryTicketId, body, live.current.signal);
      if (!live.current.signal.aborted) {
        setSigned(result.items);
        void materials.refetch();
      }
    } catch (failure) {
      if (!live.current.signal.aborted) setError(ticketActionError(failure));
    } finally {
      signing.current = false;
      if (!live.current.signal.aborted) setBusy(false);
    }
  };
  const canTake = canAction(access, "delivery.download");
  const button = (label: string, body: M5Body<"admin.deliveryTicket.material.downloadUrls">) => (
    <Button disabled={!canTake || busy} onClick={() => void take(body)}>
      {label}
    </Button>
  );
  const phases: Readonly<Record<string, string>> = {
    uploading: "等待上传",
    checking: "体检中",
    ready: "已就绪",
    rejected: "未通过",
  };
  return (
    <>
      <section className="lyx-production-card">
        <h3>制作取料</h3>
        <p>取料时逐次签发短时地址并登记记录。</p>
        {error ? <Alert type="error" title={error} /> : null}
        {materials.isError ? (
          <ErrorState message="素材读取失败" onRetry={() => void materials.refetch()} />
        ) : materials.data ? (
          <>
            <InfoList
              items={Object.entries(materials.data.profileText)
                .filter(([, value]) => value)
                .map(([key, value]) => ({
                  label:
                    (
                      {
                        brandName: "品牌",
                        brandIntro: "品牌介绍",
                        promoText: "宣传文案",
                        groupBuyText: "团购文案",
                        sellingNote: "卖点说明",
                        bannedTerms: "禁用词",
                      } as Record<string, string>
                    )[key] ?? "门店说明",
                  value,
                }))}
            />
            <ul>
              {materials.data.masters.map((master) => (
                <li key={master.dramaEpisodeMasterId}>
                  第 {master.episodeNo} 集原片 · 第 {master.revNo} 版
                  {master.myLastCheckout
                    ? ` · 已取 ${master.myLastCheckout.checkoutCount} 次，最近 ${date.dateTime(master.myLastCheckout.checkedOutAt)}`
                    : " · 尚未取料"}{" "}
                  {button(`取第 ${master.episodeNo} 集原片`, {
                    kind: "master",
                    episodeNos: [master.episodeNo],
                  })}
                </li>
              ))}
            </ul>
            <ul>
              {materials.data.ads.map((ad) => (
                <li key={ad.adVersionId}>
                  {ad.adNo} · 第 {ad.versionNo} 版{" "}
                  {button(`取广告 ${ad.adNo}`, { kind: "ad_version", adVersionId: ad.adVersionId })}
                </li>
              ))}
            </ul>
            <ul>
              {materials.data.storeAssets.map((asset, index) => (
                <li key={asset.storeAssetId}>
                  {asset.title ?? "门店素材"}{" "}
                  {button(`取门店素材 ${asset.title ?? index + 1}`, {
                    kind: "store_asset",
                    storeAssetId: asset.storeAssetId,
                  })}
                </li>
              ))}
            </ul>
            <ul>
              {materials.data.profileMedia.map((file, index) => (
                <li key={file.fileId}>
                  {file.title ?? "档案文件"}{" "}
                  {button(`取档案文件 ${index + 1}`, {
                    kind: "profile_media",
                    fileId: file.fileId,
                  })}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>正在读取素材…</p>
        )}
        {signed.length ? (
          <ul>
            {signed.map((file) => (
              <li key={file.fileId}>
                <a
                  href={localStorageRequestUrl(file.url, __LYX_LOCAL_STORAGE_ORIGIN__)}
                  target="_blank"
                  rel="noreferrer"
                >
                  下载{file.fileName}
                </a>{" "}
                · {date.dateTime(file.expiresAt)}前有效
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="lyx-production-card">
        <h3>制作事实与人工处理</h3>
        <p>规范化与补标产生新文件；本页不会自动采纳衍生文件。</p>
        <Button disabled={production.isFetching} onClick={() => void production.refetch()}>
          刷新制作事实
        </Button>
        {production.isError ? (
          <ErrorState message="制作事实读取失败" onRetry={() => void production.refetch()} />
        ) : production.data?.items.length ? (
          production.data.items.map((record) => (
            <article className="lyx-m5-record" key={record.productionRecordId}>
              <h4>
                {record.episodeNo ? `第 ${record.episodeNo} 集 · ` : ""}
                {({ sample: "样片", final: "成片", ad: "广告" } as Record<string, string>)[
                  record.kind
                ] ?? "制作文件"}
              </h4>
              <InfoList
                items={[
                  {
                    label: "处理状态",
                    value: phases[record.pipelineState] ?? record.pipelineState,
                  },
                  {
                    label: "体检",
                    value: record.check
                      ? record.check.gate === "pass"
                        ? "通过"
                        : "未通过"
                      : "等待体检",
                  },
                  { label: "AI声明", value: record.aiUsage.used ? "使用AI" : "未使用AI" },
                  {
                    label: "标识核验",
                    value:
                      (
                        {
                          not_required: "无需标识",
                          pending: "待核验",
                          verified: "已核验",
                          failed: "未通过",
                        } as Record<string, string>
                      )[record.aigcState] ?? record.aigcState,
                  },
                  {
                    label: "实际规格",
                    value: record.media
                      ? `${record.media.displayWidth ?? "—"} × ${record.media.displayHeight ?? "—"} · ${record.media.durationMs ?? "—"} 毫秒`
                      : "等待实际探测",
                  },
                ]}
              />
              {record.check ? (
                <ul>
                  {record.check.hard
                    .filter((item) => !item.pass)
                    .map((item) => (
                      <li key={item.code}>
                        {item.code}：实际 {item.actual}，要求 {item.expected}
                      </li>
                    ))}
                  {record.check.soft.map((item) => (
                    <li key={item.code}>{item.note}</li>
                  ))}
                </ul>
              ) : null}
              <div className="lyx-production-actions">
                {record.actions
                  .filter((action) => canAction(access, `production.${action}`))
                  .map((action) => (
                    <Button
                      key={action}
                      disabled={ticket.isPaused}
                      onClick={() => onAction(action, record.productionRecordId)}
                    >
                      {{ normalize: "规范化", recheck: "重新体检", restamp: "补写AI标识" }[action]}
                    </Button>
                  ))}
              </div>
            </article>
          ))
        ) : (
          <p>当前订单项暂无制作事实。</p>
        )}
        {production.data && production.data.total > 100 ? (
          <Pagination
            current={page}
            pageSize={100}
            total={production.data.total}
            showSizeChanger={false}
            onChange={setPage}
          />
        ) : null}
      </section>
    </>
  );
}
