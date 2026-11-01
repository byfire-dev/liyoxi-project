import { maxUploadBytes } from "@liyoxi/shared/uploads";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import { ConfirmPanel } from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { UploadField } from "../../../components/UploadField";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";
import type { UploadFn } from "../../../lib/upload";
import {
  createAdTasksApi,
  inspectionReady,
  type AdApi,
  type AdDetail,
  type AdVersion,
  type CancelReason,
  type Command,
} from "./api";
import { ADS_KEY, createAdWorkspace, segmentsInput } from "./model";
export const labels: Record<Command["kind"], string> = {
  assign: "指派剪辑师",
  return: "退回补充",
  "create-version": "上传广告版本",
  push: "推送给商家",
  "mark-sent": "登记企业微信已发送",
  "request-change": "代录免费修改",
  remind: "催办商家确认",
  cancel: "申请取消广告",
};
function VideoUpload({
  services,
  detail,
  aiUsed,
  tool,
  toolVersion,
  usedFor,
  onChange,
}: {
  services: AppServices;
  detail: AdDetail;
  aiUsed: boolean;
  tool: string;
  toolVersion: string;
  usedFor: string;
  onChange(id: string | null): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | null>(null),
    file = useRef<File | null>(null),
    live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      adapter.current?.close();
      adapter.current = null;
    };
  }, []);
  const upload: UploadFn = async (input, hooks) => {
    if (!live.current) throw new Error("上传窗口已关闭");
    if (file.current && file.current !== input) await adapter.current?.cancel(file.current);
    file.current = input;
    adapter.current ??= createMultipartUploadAdapter({
      ports: createAdminMultipartUploadPorts(services.api.client, {
        category: "ad_video",
        storeId: detail.store.storeId,
        production: {
          kind: "ad",
          adId: detail.adId,
          aiUsage: {
            used: aiUsed,
            tools: aiUsed
              ? [{ name: tool.trim(), version: toolVersion.trim(), usedFor: usedFor.trim() }]
              : [],
          },
        },
      }),
    });
    const result = await adapter.current.upload(input, hooks);
    await createAdTasksApi(services).checkFile(detail, result.fileId);
    if (!live.current || file.current !== input) throw new Error("此文件已不属于当前操作");
    return result;
  };
  return (
    <UploadField
      rule={{
        accept: [".mp4", ".mov"],
        maxSizeMb: Number(maxUploadBytes("ad_video", "mp4", "admin")) / 1024 / 1024,
      }}
      upload={upload}
      onChange={(id) => {
        if (live.current) onChange(id);
      }}
      text="上传本广告竖屏视频"
    />
  );
}
type AdActionFields = {
  staffId?: string;
  note: string;
  fileId: string | null;
  segments: string;
  adopted: string[];
  includeWecom: boolean;
  reason: CancelReason;
  aiUsed: boolean;
  tool: string;
  toolVersion: string;
  usedFor: string;
  segment: number | null;
};
export function AdActionModal({
  kind,
  version,
  detail,
  api,
  services,
  scope,
  onClose,
  onDone,
}: {
  kind: Command["kind"];
  version?: AdVersion;
  detail: AdDetail;
  api: AdApi;
  services: AppServices;
  scope: string;
  onClose(): void;
  onDone(detail: AdDetail): void;
}) {
  const workspace = useRef<ReturnType<typeof createAdWorkspace> | undefined>(undefined);
  const live = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    const owner = createAdWorkspace(api, detail.adId);
    workspace.current = owner;
    live.current = true;
    return () => {
      live.current = false;
      owner.close();
      if (workspace.current === owner) workspace.current = undefined;
    };
  }, [api, detail.adId]);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [staffPage, setStaffPage] = useState(1);
  const [fields, setFields] = useState<AdActionFields>({
    note: "",
    fileId: null,
    segments: "",
    adopted: [],
    includeWecom: false,
    reason: "merchant_request",
    aiUsed: false,
    tool: "",
    toolVersion: "",
    usedFor: "",
    segment: null,
  });
  const {
    staffId,
    note,
    fileId,
    segments,
    adopted,
    includeWecom,
    reason,
    aiUsed,
    tool,
    toolVersion,
    usedFor,
    segment,
  } = fields;
  const setField = <K extends keyof AdActionFields>(key: K, value: AdActionFields[K]) =>
    setFields((current) => ({ ...current, [key]: value }));
  const candidates = useQuery({
    queryKey: [...ADS_KEY, scope, "staff", staffPage],
    queryFn: () => api.staff(staffPage),
    enabled: kind === "assign",
  });
  const work = useQuery({
    queryKey: [...ADS_KEY, scope, "work", staffId],
    queryFn: () => api.openWork(staffId!),
    enabled: kind === "assign" && !!staffId,
  });
  const quote = useQuery({
    queryKey: [...ADS_KEY, scope, "cancel-quote", detail.adId, reason],
    queryFn: () => api.cancelQuote(detail.adId, reason),
    enabled: kind === "cancel",
    staleTime: 0,
  });
  const inspection = useQuery({
    queryKey: [...ADS_KEY, scope, "inspection", detail.adId, fileId],
    queryFn: ({ signal }) => api.production(fileId!, detail.adId, signal),
    enabled: kind === "create-version" && !!fileId,
    refetchInterval: (query) =>
      query.state.data?.pipelineState === "ready" || query.state.data?.pipelineState === "rejected"
        ? false
        : 2000,
  });
  // A checkbox acknowledges this exact form and the current quote/check facts.
  // Changed inputs create a new fields object, so even changing them back needs consent again.
  const [confirmation, setConfirmation] = useState<{
    fields: AdActionFields;
    quote: typeof quote.data;
    inspection: typeof inspection.data;
  }>();
  const checked =
    !!confirmation &&
    confirmation.fields === fields &&
    confirmation.quote === quote.data &&
    confirmation.inspection === inspection.data;
  const ready =
    !!fileId &&
    !inspection.isError &&
    !inspection.isFetching &&
    inspectionReady(inspection.data ?? null, fileId, detail.adId);
  const valid =
    kind === "assign"
      ? !!staffId && work.isSuccess
      : kind === "return" || kind === "request-change"
        ? !!note.trim()
        : kind === "cancel"
          ? note.trim().length >= 5 && !!quote.data && !quote.isFetching
          : kind === "create-version"
            ? ready
            : true;
  const submit = async () => {
    const owner = workspace.current;
    if (!checked || !valid || running.current || !owner) return;
    running.current = true;
    let command: Command;
    try {
      switch (kind) {
        case "assign":
          command = { kind, body: { staffId: staffId! } };
          break;
        case "return":
          command = { kind, body: { reason: note.trim() } };
          break;
        case "request-change":
          command = {
            kind,
            body: {
              versionNo: detail.latestVersionNo,
              note: note.trim(),
              ...(segment !== null ? { segmentIndex: segment } : {}),
            },
          };
          break;
        case "create-version":
          command = {
            kind,
            body: {
              fileId: fileId!,
              segments: segmentsInput(segments),
              adoptedStoreAssetIds: adopted,
            },
          };
          break;
        case "push":
          command = { kind, versionId: version!.adVersionId, body: { includeWecom } };
          break;
        case "mark-sent":
          command = { kind, versionId: version!.adVersionId, body: {} };
          break;
        case "remind":
          command = { kind, body: {} };
          break;
        case "cancel":
          command = {
            kind,
            body: {
              reasonCode: reason,
              note: note.trim(),
              expect: { totalRefundPoints: quote.data!.totalRefundPoints },
            },
          };
          break;
      }
      setPending(true);
      setError(undefined);
      const result = await owner.submit(command);
      if (live.current && result) {
        onDone(result);
        onClose();
      }
    } catch (failure) {
      if (live.current) {
        setError(failure instanceof Error ? failure.message : "请求未完成，请刷新后重试");
        void services.queryClient.invalidateQueries({ queryKey: ADS_KEY });
      }
    } finally {
      running.current = false;
      if (live.current) setPending(false);
    }
  };
  return (
    <Modal
      open
      title={labels[kind]}
      width={640}
      footer={null}
      onCancel={() => {
        if (!pending) onClose();
      }}
      closable={!pending}
      keyboard={!pending}
      mask={{ closable: !pending }}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      <div className="lyx-ad-form">
        {kind === "assign" ? (
          <>
            <FormField label="剪辑师">
              {(field) => (
                <Select
                  {...field}
                  placeholder="选择当前在职剪辑师"
                  showSearch
                  optionFilterProp="label"
                  value={staffId}
                  disabled={pending}
                  loading={candidates.isFetching}
                  onChange={(value) => setField("staffId", value)}
                  options={candidates.data?.items
                    .filter((s) => s.isActivated && !s.isLocked)
                    .map((s) => ({
                      value: s.staffId,
                      label: `${s.name}${s.isRecommended ? " · 推荐" : ""} · 在办${s.openWorkCount ?? "未知"}`,
                    }))}
                />
              )}
            </FormField>
            {candidates.isError ? (
              <Alert
                type="error"
                title="候选读取失败"
                action={<Button onClick={() => void candidates.refetch()}>重试</Button>}
              />
            ) : null}
            <Space>
              <Button
                disabled={staffPage <= 1 || pending}
                onClick={() => {
                  setStaffPage((v) => v - 1);
                  setField("staffId", undefined);
                }}
              >
                上一页候选
              </Button>
              <Button
                disabled={
                  !candidates.data ||
                  staffPage * candidates.data.pageSize >= candidates.data.total ||
                  pending
                }
                onClick={() => {
                  setStaffPage((v) => v + 1);
                  setField("staffId", undefined);
                }}
              >
                下一页候选
              </Button>
            </Space>
            {work.data ? (
              <p>
                总在办 {work.data.total}；广告在办{" "}
                {work.data.bySource
                  .filter((r) => r.subjectType === "ad")
                  .map((r) => r.count)
                  .join("、") || "来源未返回"}
              </p>
            ) : null}
            {work.isError ? (
              <Alert
                type="error"
                title="在办事实读取失败"
                action={<Button onClick={() => void work.refetch()}>重试</Button>}
              />
            ) : null}
          </>
        ) : null}
        {kind === "create-version" ? (
          <>
            <Alert type="info" title="竖屏9:16，1080×1920；登记将核验真实时长和媒体检查结果" />
            <Checkbox
              checked={aiUsed}
              disabled={!!fileId || pending}
              onChange={(e) => setField("aiUsed", e.target.checked)}
            >
              本版使用了AI工具
            </Checkbox>
            {aiUsed ? (
              <FormField label="AI工具名称">
                {(field) => (
                  <Input
                    {...field}
                    value={tool}
                    onChange={(e) => setField("tool", e.target.value)}
                    disabled={!!fileId || pending}
                  />
                )}
              </FormField>
            ) : null}
            {aiUsed ? (
              <>
                <FormField label="AI工具版本">
                  {(field) => (
                    <Input
                      {...field}
                      value={toolVersion}
                      onChange={(e) => setField("toolVersion", e.target.value)}
                      disabled={!!fileId || pending}
                    />
                  )}
                </FormField>
                <FormField label="AI使用环节">
                  {(field) => (
                    <Input
                      {...field}
                      value={usedFor}
                      onChange={(e) => setField("usedFor", e.target.value)}
                      disabled={!!fileId || pending}
                    />
                  )}
                </FormField>
              </>
            ) : null}
            {!aiUsed || (tool.trim() && toolVersion.trim() && usedFor.trim()) ? (
              <VideoUpload
                key={`${aiUsed}:${tool}:${toolVersion}:${usedFor}`}
                services={services}
                detail={detail}
                aiUsed={aiUsed}
                tool={tool}
                toolVersion={toolVersion}
                usedFor={usedFor}
                onChange={(value) => setField("fileId", value)}
              />
            ) : null}
            {fileId ? <p>文件已入库；登记时仍须通过广告媒体检查。</p> : null}
            {fileId ? (
              <>
                <Alert
                  type={
                    ready
                      ? "success"
                      : inspection.isError || inspection.data?.pipelineState === "rejected"
                        ? "error"
                        : "info"
                  }
                  title={
                    ready
                      ? "媒体检查通过，可登记版本"
                      : inspection.isError
                        ? "检查状态读取失败，请重试"
                        : inspection.data?.pipelineState === "rejected"
                          ? "媒体检查未通过，请更换文件"
                          : "媒体检查中，请稍候或刷新状态"
                  }
                />
                <Button
                  disabled={inspection.isFetching || pending}
                  onClick={() => void inspection.refetch()}
                >
                  刷新检查状态
                </Button>
              </>
            ) : null}
            <FormField label="分段（可选，每行：开始毫秒,结束毫秒,广告标签）">
              {(field) => (
                <Input.TextArea
                  {...field}
                  rows={3}
                  value={segments}
                  onChange={(e) => setField("segments", e.target.value)}
                  disabled={pending}
                />
              )}
            </FormField>
            <FormField label="本版采用的门店素材">
              {(field) => (
                <Select
                  {...field}
                  mode="multiple"
                  value={adopted}
                  onChange={(value) => setField("adopted", value)}
                  disabled={pending}
                  options={detail.referenceFiles
                    .filter((r) => r.storeAssetId && r.usability === "usable")
                    .map((r) => ({ value: r.storeAssetId!, label: r.title ?? r.fileId }))}
                />
              )}
            </FormField>
          </>
        ) : null}
        {["return", "request-change", "cancel"].includes(kind) ? (
          <FormField
            label={
              kind === "return"
                ? "退回原因"
                : kind === "cancel"
                  ? "取消说明（至少5字）"
                  : "修改意见"
            }
            value={note}
            maxLength={200}
          >
            {(field) => (
              <Input.TextArea
                {...field}
                rows={4}
                value={note}
                maxLength={200}
                disabled={pending}
                onChange={(e) => setField("note", e.target.value)}
              />
            )}
          </FormField>
        ) : null}
        {kind === "request-change" ? (
          <>
            <p>
              本次基于第 {detail.latestVersionNo} 版；已修改 {detail.revisionCount} 次，免费额度{" "}
              {detail.freeRevisionQuota} 次。超次须由商家确认收费。
            </p>
            <FormField label="分段索引（可选，从0开始）">
              {(field) => (
                <InputNumber
                  {...field}
                  min={0}
                  precision={0}
                  value={segment}
                  onChange={(value) => setField("segment", value)}
                  disabled={pending}
                />
              )}
            </FormField>
          </>
        ) : null}
        {kind === "push" ? (
          <Checkbox
            checked={includeWecom}
            disabled={pending || !version?.offlineSentAt}
            onChange={(e) => setField("includeWecom", e.target.checked)}
          >
            包含已登记的企业微信发送事实
          </Checkbox>
        ) : null}
        {kind === "mark-sent" ? (
          <Alert
            type="warning"
            title="仅在确已通过企业微信发送此版本后登记；此操作不执行外部发送。"
          />
        ) : null}
        {kind === "cancel" ? (
          <>
            <FormField label="取消原因">
              {(field) => (
                <Select
                  {...field}
                  value={reason}
                  disabled={pending}
                  onChange={(value) => setField("reason", value)}
                  options={[
                    { value: "merchant_request", label: "商家申请" },
                    { value: "store_closed", label: "门店关闭" },
                    { value: "platform_fault", label: "平台原因" },
                  ]}
                />
              )}
            </FormField>
            {quote.isError ? (
              <Alert
                type="error"
                title="取消预览读取失败"
                action={<Button onClick={() => void quote.refetch()}>重试</Button>}
              />
            ) : null}
            {quote.data ? (
              <div>
                <p>本次预览退回 {quote.data.totalRefundPoints} 积分</p>
                {quote.data.lines.map((line) => (
                  <p key={line.targetId}>
                    {line.label}：原扣 {line.chargePoints}，扣除 {line.deductPoints}，退回{" "}
                    {line.refundPoints}；原去向 {line.preview.backToOriginal}，转加购{" "}
                    {line.preview.convertedToAddon}，失效 {line.preview.forfeited}
                  </p>
                ))}
                <p>此处仅提交取消申请，审批执行后才产生实际退积分。</p>
              </div>
            ) : null}
          </>
        ) : null}
        {error ? <Alert type="error" title={error} /> : null}
        <ConfirmPanel
          spec={{
            title: labels[kind],
            echo: [
              { label: "广告", value: detail.adNo },
              { label: "门店", value: detail.store.storeName ?? "未命名门店" },
              {
                label: "版本",
                value:
                  version || detail.latestVersionNo > 0
                    ? String(version?.versionNo ?? detail.latestVersionNo)
                    : "未登记版本",
              },
              ...(kind === "cancel" && quote.data
                ? [
                    {
                      label: "申请退回积分",
                      value: String(quote.data.totalRefundPoints),
                      emphasis: true,
                    },
                  ]
                : []),
            ],
            checkLabel: "我已核对当前广告、版本和本次操作",
            danger: kind === "cancel" || kind === "return",
          }}
          input={{ checked: checked && valid, typed: "" }}
          onInputChange={(value) =>
            setConfirmation(
              value.checked
                ? { fields, quote: quote.data, inspection: inspection.data }
                : undefined,
            )
          }
          submitting={pending}
          onCancel={onClose}
          onConfirm={() => void submit()}
        />
      </div>
    </Modal>
  );
}
