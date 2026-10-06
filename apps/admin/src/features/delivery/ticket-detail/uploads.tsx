import { Alert, Button, Checkbox, Input, InputNumber, Modal, Progress } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { UploadField } from "../../../components/UploadField";
import { Can } from "../../../lib/permissions";
import { validateUploadFile } from "../../../lib/upload";
import type { DetailApi, FileBody, Ticket } from "./api";
import { episodeProblem, firstEpisode } from "./model";
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
  ticket: Ticket,
  kind: "sample" | "final",
  episodeNo: number,
  aiUsage: AiUsage,
): Omit<FileBody, "fileName" | "sizeBytes" | "clientToken" | "mime"> {
  return {
    category: kind === "sample" ? "sample_video" : "final_episode",
    storeId: ticket.store.storeId,
    production: { kind, orderItemId: ticket.orderItemId, episodeNo, aiUsage },
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
  const input = useMemo(() => context(ticket, "sample", 1, ai), [ticket, ai]),
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
export function SampleUploadModal({
  ticket,
  api,
  onClose,
  onRefresh,
}: {
  ticket: Ticket;
  api: DetailApi;
  onClose(): void;
  onRefresh(): void;
}) {
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
interface EpisodeRow {
  id: string;
  file: File;
  episodeNo?: number;
  fileId: string | null;
  busy: boolean;
}
function EpisodeUpload({
  row,
  ticket,
  api,
  ai,
  numberError,
  onChange,
  onRemove,
  disabled,
}: {
  row: EpisodeRow;
  ticket: Ticket;
  api: DetailApi;
  ai: AiUsage;
  numberError?: string;
  onChange(patch: Partial<EpisodeRow>): void;
  onRemove(): void;
  disabled: boolean;
}) {
  const [percent, setPercent] = useState(0),
    [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const input = useMemo(
      () => context(ticket, "final", row.episodeNo ?? 1, ai),
      [ticket, row.episodeNo, ai],
    ),
    slot = useUploadLifetime(api, input);
  const upload = async () => {
    const lifetime = slot();
    if (busyRef.current || row.fileId || numberError || disabled || !lifetime?.active) return;
    const problem = validateUploadFile(row.file, productionUploadRule);
    if (problem) {
      setError(problem);
      return;
    }
    busyRef.current = true;
    onChange({ busy: true });
    setError(undefined);
    try {
      const result = await lifetime.adapter.upload(row.file, {
        onProgress: (value) => {
          if (lifetime.active) setPercent(value);
        },
      });
      if (lifetime.active) onChange({ fileId: result.fileId });
    } catch (e) {
      if (lifetime.active && e instanceof Error && e.name !== "AbortError") setError(e.message);
    } finally {
      busyRef.current = false;
      if (lifetime.active) onChange({ busy: false });
    }
  };
  return (
    <section className="lyx-production-card">
      <strong>{row.file.name}</strong>
      <p>
        {(row.file.size / 1024 / 1024).toFixed(2)} MB ·{" "}
        {row.fileId ? "已入库" : row.busy ? "上传中" : "待上传"}
      </p>
      <div className="lyx-production-actions">
        <FormField label={`文件 ${row.file.name} 集号`} error={numberError}>
          {(field) => (
            <InputNumber
              {...field}
              min={1}
              max={ticket.episodeCount}
              precision={0}
              value={row.episodeNo}
              disabled={disabled || row.busy || !!row.fileId}
              onChange={(value) => onChange({ episodeNo: value ?? undefined })}
            />
          )}
        </FormField>
        <Button
          disabled={disabled || !!numberError || !!row.fileId}
          loading={row.busy}
          onClick={() => void upload()}
        >
          {error ? "重试上传" : "上传文件"}
        </Button>
        <Button disabled={disabled || row.busy} onClick={onRemove}>
          移除文件
        </Button>
      </div>
      {row.busy ? <Progress percent={percent} /> : null}
      {row.fileId ? <p>集号已与上传登记绑定；需要改集号时请移除后重新选文件。</p> : null}
      {error ? <Alert type="error" title={error} /> : null}
    </section>
  );
}
export function EpisodeRegisterModal({
  ticket,
  api,
  onClose,
  onRefresh,
}: {
  ticket: Ticket;
  api: DetailApi;
  onClose(): void;
  onRefresh(): void;
}) {
  const [rows, setRows] = useState<EpisodeRow[]>([]),
    [ai, setAi] = useState<AiUsage>(plain),
    [selectionError, setSelectionError] = useState<string>();
  const write = useDeliveryWrite(() => {
    onRefresh();
    onClose();
  });
  const problem = episodeProblem(rows, ticket.episodeCount),
    busy = rows.some((r) => r.busy);
  return (
    <Modal
      open
      title="登记成片"
      width={680}
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
          {ticket.store.storeName ?? "未命名门店"} · {ticket.dramaTitle} · 共 {ticket.episodeCount}{" "}
          集
        </p>
        <AiDeclaration
          value={ai}
          onChange={setAi}
          disabled={rows.some((r) => r.busy || !!r.fileId) || write.pending}
        />
        <FormField label="选择成片文件">
          {(field) => (
            <input
              {...field}
              className="lyx-production-file-select"
              type="file"
              accept=".mp4,.mov"
              multiple
              disabled={busy || write.pending}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length + rows.length > Math.min(100, ticket.episodeCount)) {
                  setSelectionError("所选文件数超过本工单集数，请分次登记");
                  return;
                }
                setSelectionError(undefined);
                setRows((old) => [
                  ...old,
                  ...files.map((file) => ({
                    id: crypto.randomUUID(),
                    file,
                    episodeNo: firstEpisode(file.name),
                    fileId: null,
                    busy: false,
                  })),
                ]);
              }}
            />
          )}
        </FormField>
        <p>按文件名中的第一个数字预填集号；请先核对，再逐个上传。广告版本：共用。</p>
        {selectionError ? <Alert type="error" title={selectionError} /> : null}
        {rows.map((row) => (
          <EpisodeUpload
            key={row.id}
            row={row}
            ticket={ticket}
            api={api}
            ai={ai}
            disabled={write.pending}
            numberError={
              !row.episodeNo ||
              row.episodeNo < 1 ||
              row.episodeNo > ticket.episodeCount ||
              !Number.isInteger(row.episodeNo)
                ? "集号越界，请修改"
                : rows.filter((r) => r.episodeNo === row.episodeNo).length > 1
                  ? "集号重复，请修改"
                  : undefined
            }
            onRemove={() => setRows((old) => old.filter((r) => r.id !== row.id))}
            onChange={(patch) =>
              setRows((old) => old.map((r) => (r.id === row.id ? { ...r, ...patch } : r)))
            }
          />
        ))}
        {rows.length && problem ? <p role="alert">{problem}</p> : null}
        {write.error ? <Alert type="error" title={write.error} /> : null}
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {ticket.actions.includes("episode-register") ? (
            <Can module="delivery" need="o" action="delivery.episode.register">
              <Button
                type="primary"
                disabled={!!problem || busy}
                loading={write.pending}
                onClick={() => {
                  if (problem) return;
                  const body = {
                    items: rows.map((r) => ({
                      episodeNo: r.episodeNo!,
                      fileId: r.fileId!,
                      variant: "common" as const,
                    })),
                  };
                  void write.submit({ ticketId: ticket.deliveryTicketId, ...body }, (key) =>
                    api.registerEpisodes(ticket.deliveryTicketId, body, key),
                  );
                }}
              >
                登记成片文件
              </Button>
            </Can>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
