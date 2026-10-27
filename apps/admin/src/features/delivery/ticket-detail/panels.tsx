import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Modal } from "antd";
import { useState } from "react";
import { InfoList } from "../../../components/InfoList";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { localStorageRequestUrl } from "../../../lib/local-storage";
import { Can } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import type { DetailApi, Ticket } from "./api";
import { DETAIL_KEY } from "./model";
import { QualityModal } from "./quality";
import { EpisodeRegisterModal, SampleUploadModal } from "./uploads";
import { useDeliveryWrite } from "./write";
interface PanelProps {
  ticket: Ticket;
  api: DetailApi;
  onRefresh(): void;
}
function PushSampleModal({ ticket, api, onClose, onRefresh }: PanelProps & { onClose(): void }) {
  const [checked, setChecked] = useState(false),
    sample = ticket.currentSample!;
  const write = useDeliveryWrite(() => {
    onRefresh();
    onClose();
  });
  return (
    <Modal
      open
      title="推送样片"
      footer={null}
      onCancel={() => {
        if (!write.pending) onClose();
      }}
      closable={!write.pending}
      keyboard={!write.pending}
      mask={{ closable: !write.pending }}
    >
      <div className="lyx-production-form">
        <p>
          {ticket.store.storeName ?? "未命名门店"} · 样片第 {sample.versionNo} 版
        </p>
        <Checkbox
          checked={checked}
          disabled={write.pending}
          onChange={(e) => setChecked(e.target.checked)}
        >
          确认将此版样片推送给商家
        </Checkbox>
        {write.error ? <Alert type="error" title={write.error} /> : null}
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {sample.actions.includes("push") ? (
            <Can module="delivery" need="o" action="delivery.sample.push">
              <Button
                type="primary"
                disabled={!checked}
                loading={write.pending}
                onClick={() =>
                  void write.submit({ sampleId: sample.sampleId }, (key) =>
                    api.pushSample(sample.sampleId, key),
                  )
                }
              >
                确认推送
              </Button>
            </Can>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
export function SamplePanel({ ticket, api, onRefresh }: PanelProps) {
  const [open, setOpen] = useState<"upload" | "qc" | "push">(),
    sample = ticket.currentSample;
  return (
    <div className="lyx-production-sections">
      {sample ? (
        <>
          <h2 className="lyx-section-title">样片第 {sample.versionNo} 版</h2>
          {sample.preview?.url ? (
            <video
              controls
              preload="metadata"
              src={localStorageRequestUrl(sample.preview.url, __LYX_LOCAL_STORAGE_ORIGIN__)}
              aria-label="样片预览"
            />
          ) : (
            <p>预览地址暂不可用，请刷新重试</p>
          )}
          <InfoList
            items={[
              { label: "上传人", value: sample.uploadedBy.name },
              { label: "上传时间", value: date.dateTime(sample.uploadedAt) },
              {
                label: "质检",
                value:
                  sample.qc?.verdict === "pass"
                    ? "通过"
                    : sample.qc?.verdict === "fail"
                      ? "不通过"
                      : "待质检",
              },
              { label: "不通过原因", value: sample.qc?.rejectReason ?? "—" },
              { label: "质检人", value: sample.qc?.inspectedBy?.name ?? "—" },
            ]}
          />
          {sample.qc ? (
            <div className="lyx-production-qc-results">
              {sample.qc.items.map((r) => (
                <p key={r.key}>
                  {r.label}：
                  {r.result === "pass" ? "通过" : r.result === "fail" ? "不通过" : "不适用"}
                  {r.note ? `（${r.note}）` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState title="暂无样片" description="交付方案确认后上传样片" />
      )}
      <div className="lyx-production-actions">
        {ticket.actions.includes("sample-create") ? (
          <Can module="delivery" need="o" action="delivery.sample.upload">
            <Button onClick={() => setOpen("upload")}>上传样片</Button>
          </Can>
        ) : null}
        {sample?.actions.includes("inspect") ? (
          <Can module="delivery" need="o" action="delivery.sample.qc">
            <Button type="primary" onClick={() => setOpen("qc")}>
              样片质检
            </Button>
          </Can>
        ) : null}
        {sample?.actions.includes("push") ? (
          <Can module="delivery" need="o" action="delivery.sample.push">
            <Button type="primary" onClick={() => setOpen("push")}>
              推送样片
            </Button>
          </Can>
        ) : null}
      </div>
      {open === "upload" ? (
        <SampleUploadModal
          ticket={ticket}
          api={api}
          onClose={() => setOpen(undefined)}
          onRefresh={onRefresh}
        />
      ) : null}
      {open === "qc" && sample ? (
        <QualityModal
          mode="sample"
          ticket={ticket}
          api={api}
          onClose={() => setOpen(undefined)}
          onRefresh={onRefresh}
        />
      ) : null}
      {open === "push" && sample ? (
        <PushSampleModal
          key={`${sample.sampleId}:${sample.versionNo}`}
          ticket={ticket}
          api={api}
          onClose={() => setOpen(undefined)}
          onRefresh={onRefresh}
        />
      ) : null}
    </div>
  );
}
export function EpisodePanel({ ticket, api, onRefresh }: PanelProps) {
  const [open, setOpen] = useState<"register" | "episodes" | "package">();
  const grid = useQuery({
    queryKey: [...DETAIL_KEY, "episodes", ticket.deliveryTicketId],
    queryFn: () => api.episodes(ticket.deliveryTicketId),
    ...DETAIL_QUERY,
  });
  return (
    <div className="lyx-production-sections">
      <InfoList
        items={[
          {
            label: "剧集",
            value: `已通过 ${grid.data?.currentPassedCount ?? ticket.episodeProgress.currentPassedCount} / ${ticket.episodeCount} 集`,
          },
          {
            label: "成片包质检",
            value:
              grid.data?.packageQc?.verdict === "pass"
                ? "通过"
                : grid.data?.packageQc?.verdict === "fail"
                  ? "不通过"
                  : "待质检",
          },
          {
            label: "发布安排",
            value: ticket.agreedLaunchDate ? date.date(ticket.agreedLaunchDate) : "待确认",
          },
        ]}
      />
      {grid.isError ? (
        <ErrorState message={grid.error.message} onRetry={() => void grid.refetch()} />
      ) : grid.isPending ? (
        <p>正在读取剧集…</p>
      ) : (
        <>
          <div className="lyx-production-episode-grid">
            {grid.data.episodes.map((e) => {
              const output = e.latest ?? e.current;
              return (
                <section className="lyx-production-card" key={e.episodeNo}>
                  <h3>第 {e.episodeNo} 集</h3>
                  <p>
                    {output
                      ? `第 ${output.revisionNo} 版 · ${output.qc?.verdict === "pass" ? "通过" : output.qc?.verdict === "fail" ? "不通过" : "待质检"}`
                      : "待登记"}
                  </p>
                  {output ? (
                    <>
                      <p>{output.fileName ?? "成片文件"}</p>
                      <small>
                        {output.uploadedBy.name} · {date.dateTime(output.uploadedAt)}
                      </small>
                      {output.qc?.rejectReason ? <p>原因：{output.qc.rejectReason}</p> : null}
                    </>
                  ) : null}
                </section>
              );
            })}
          </div>
          {grid.data.packageQc?.rejectReason ? (
            <Alert type="warning" title={`成片包不通过：${grid.data.packageQc.rejectReason}`} />
          ) : null}
        </>
      )}
      <div className="lyx-production-actions">
        {ticket.actions.includes("episode-register") ? (
          <Can module="delivery" need="o" action="delivery.episode.register">
            <Button onClick={() => setOpen("register")}>登记成片</Button>
          </Can>
        ) : null}
        {ticket.actions.includes("inspect-episodes") ? (
          <Can module="delivery" need="o" action="delivery.episode.qc">
            <Button type="primary" disabled={!grid.data} onClick={() => setOpen("episodes")}>
              逐集质检
            </Button>
          </Can>
        ) : null}
        {ticket.actions.includes("inspect-package") ? (
          <Can module="delivery" need="o" action="delivery.episode.qc">
            <Button type="primary" disabled={!grid.data} onClick={() => setOpen("package")}>
              成片包质检
            </Button>
          </Can>
        ) : null}
      </div>
      {open === "register" ? (
        <EpisodeRegisterModal
          ticket={ticket}
          api={api}
          onClose={() => setOpen(undefined)}
          onRefresh={onRefresh}
        />
      ) : null}
      {(open === "episodes" || open === "package") && grid.data ? (
        <QualityModal
          mode={open}
          ticket={ticket}
          grid={grid.data}
          api={api}
          onClose={() => setOpen(undefined)}
          onRefresh={onRefresh}
        />
      ) : null}
    </div>
  );
}
