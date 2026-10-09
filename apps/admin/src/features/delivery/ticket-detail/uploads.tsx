import { Alert, Button, Checkbox, Input, Modal } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { UploadField } from "../../../components/UploadField";
import { Can } from "../../../lib/permissions";
import type { DetailApi, FileBody, Ticket } from "./api";
import { BatchUploadModal } from "./batch-upload";
import { createProductionUpload, productionUploadRule } from "./upload";
import { useDeliveryWrite } from "./write";
type AiUsage = NonNullable<FileBody["production"]>["aiUsage"];
const plain: AiUsage = { used: false, tools: [] };
function AiDeclaration({
  value,
  onChange,
  disabled,
}: {
  value: AiUsage;
  onChange(value: AiUsage): void;
  disabled: boolean;
}) {
  const tool = value.tools[0] ?? { name: "", version: "", usedFor: "" };
  return (
    <>
      <Checkbox
        checked={value.used}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? { used: true, tools: [tool] } : plain)}
      >
        制作中使用了 AI 工具
      </Checkbox>
      {value.used ? (
        <div className="lyx-production-two">
          {(["name", "version", "usedFor"] as const).map((key) => (
            <FormField
              key={key}
              label={key === "name" ? "工具名称" : key === "version" ? "工具版本" : "使用用途"}
            >
              {(field) => (
                <Input
                  {...field}
                  value={tool[key]}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ used: true, tools: [{ ...tool, [key]: e.target.value }] })
                  }
                />
              )}
            </FormField>
          ))}
          <p>AI 文件需完成标识校验后才能登记与质检。</p>
        </div>
      ) : null}
    </>
  );
}
function context(
  storeId: string,
  orderItemId: string,
  kind: "sample" | "final",
  episodeNo: number,
  aiUsage: AiUsage,
): Omit<FileBody, "fileName" | "sizeBytes" | "clientToken" | "mime"> {
  return {
    category: kind === "sample" ? "sample_video" : "final_episode",
    storeId,
    production: { kind, orderItemId, episodeNo, aiUsage },
  };
}
type UploadLifetime = { active: boolean; adapter: ReturnType<typeof createProductionUpload> };
function useUploadLifetime(api: DetailApi, input: ReturnType<typeof context>) {
  const slot = useRef<UploadLifetime | undefined>(undefined);
  useEffect(() => {
    const lifetime = { active: true, adapter: createProductionUpload(api, input) };
    slot.current = lifetime;
    return () => {
      lifetime.active = false;
      lifetime.adapter.dispose();
    };
  }, [api, input, slot]);
  return useCallback(() => slot.current, []);
}
function SampleUpload({
  ticket,
  api,
  ai,
  onChange,
  onBusy,
  disabled,
}: {
  ticket: Ticket;
  api: DetailApi;
  ai: AiUsage;
  onChange(id: string | null): void;
  onBusy(busy: boolean): void;
  disabled: boolean;
}) {
  const storeId = ticket.store.storeId,
    orderItemId = ticket.orderItemId;
  const input = useMemo(
      () => context(storeId, orderItemId, "sample", 1, ai),
      [storeId, orderItemId, ai],
    ),
    slot = useUploadLifetime(api, input);
  const upload = useMemo(
    () => async (file: File, hooks: { onProgress(value: number): void }) => {
      const lifetime = slot();
      if (!lifetime?.active) throw new DOMException("上传已取消", "AbortError");
      onBusy(true);
      try {
        return await lifetime.adapter.upload(file, {
          onProgress: (value) => {
            if (lifetime.active) hooks.onProgress(value);
          },
        });
      } finally {
        if (lifetime.active) onBusy(false);
      }
    },
    [onBusy, slot],
  );
  return (
    <UploadField
      rule={productionUploadRule}
      upload={upload}
      onChange={(id) => {
        if (slot()?.active) onChange(id);
      }}
      disabled={disabled}
      text="选择样片视频"
    />
  );
}
interface UploadModalProps {
  ticket: Ticket;
  api: DetailApi;
  onClose(): void;
  onRefresh(): void;
}
const uploadModalIdentity = (ticket: Ticket) =>
  JSON.stringify([ticket.deliveryTicketId, ticket.store.storeId, ticket.orderItemId]);
export function SampleUploadModal(props: UploadModalProps) {
  return <SampleUploadForm key={uploadModalIdentity(props.ticket)} {...props} />;
}
function SampleUploadForm({ ticket, api, onClose, onRefresh }: UploadModalProps) {
  const [fileId, setFileId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [ai, setAi] = useState<AiUsage>(plain);
  const write = useDeliveryWrite(() => {
    onRefresh();
    onClose();
  });
  return (
    <Modal
      open
      title="上传样片"
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
          {ticket.store.storeName ?? "未命名门店"} · {ticket.dramaTitle} · 样片第 1 集 ·
          广告位：暂无
        </p>
        <AiDeclaration value={ai} onChange={setAi} disabled={busy || !!fileId || write.pending} />
        <SampleUpload
          ticket={ticket}
          api={api}
          ai={ai}
          onChange={setFileId}
          onBusy={setBusy}
          disabled={write.pending}
        />
        <p>上传成功并完成入库后，可登记为当前样片。</p>
        {write.error ? <Alert type="error" title={write.error} /> : null}
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {ticket.actions.includes("sample-create") ? (
            <Can module="delivery" need="o" action="delivery.sample.upload">
              <Button
                type="primary"
                loading={write.pending}
                disabled={!fileId || busy}
                onClick={() => {
                  if (fileId)
                    void write.submit(
                      { ticketId: ticket.deliveryTicketId, fileId, adSlots: [] },
                      (key) => api.sample(ticket.deliveryTicketId, fileId, key),
                    );
                }}
              >
                登记样片
              </Button>
            </Can>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
export function EpisodeRegisterModal(props: UploadModalProps) {
  return <BatchUploadModal key={uploadModalIdentity(props.ticket)} {...props} />;
}
