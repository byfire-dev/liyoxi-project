import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Select, Space } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import {
  ConfirmPanel,
  confirmReady,
  type ConfirmInput,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { AccessContext } from "../../../lib/permissions";
import { moneyText } from "../payments/model";
import { InvoiceFailure, invoiceError, invoiceNeedsReload, type InvoiceApi } from "./api";
import {
  allowedInvoiceActions,
  createInvoiceIntent,
  emptyInvoiceDraft,
  invoiceActions,
  invoiceCommand,
  invoiceStamp,
} from "./model";
import type { InvoiceAction, InvoiceDetail, InvoiceDraft } from "./types";
import { InvoiceUpload } from "./upload";

export function InvoiceActions({
  row,
  api,
  services,
  scope,
  refresh,
  changed,
}: {
  row: InvoiceDetail;
  api: InvoiceApi;
  services: AppServices;
  scope: string;
  refresh(signal: AbortSignal): Promise<InvoiceDetail>;
  changed(): void;
}) {
  const access = useContext(AccessContext),
    intent = useMemo(() => createInvoiceIntent(), []),
    alive = useRef(true),
    reading = useRef<AbortController | undefined>(undefined),
    [action, setAction] = useState<InvoiceAction>(),
    [draft, setDraft] = useState(emptyInvoiceDraft),
    [input, setInput] = useState<ConfirmInput & { stamp?: string }>({ checked: false, typed: "" }),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [notice, setNotice] = useState<string>();
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      reading.current?.abort();
    };
  }, [intent]);
  const actions = allowedInvoiceActions(row, access),
    stamp = invoiceStamp(row),
    needsDictionary = action === "reject" || (action === "issue" && row.medium === "paper"),
    dictionaries = useQuery({
      queryKey: ["finance", scope, "invoice-dictionary", action],
      queryFn: ({ signal }) =>
        api.dictionary(
          action === "reject" ? "reject_reason" : "express_company",
          signal,
          action === "reject" ? "invoice" : undefined,
        ),
      enabled: needsDictionary,
      retry: false,
    }),
    available = action !== undefined && actions.includes(action),
    confirmation = JSON.stringify([stamp, draft]),
    spec: ConfirmSpec = {
      title: action ? invoiceActions[action] : "处理发票",
      description:
        action === "resend"
          ? "重新提交邮件投递，不代表收件人已收到。"
          : action === "issue-red"
            ? "仅登记已开具的红字发票；退款仍由原退款流程处理。"
            : "提交前将重新读取当前申请；请核对真实发票与金额。",
      echo: [
        { label: "申请单", value: row.requestNo },
        { label: "商家", value: row.entity.name },
        { label: "当前版本", value: String(row.lockVersion) },
        { label: "金额", value: moneyText(row.amountFen), emphasis: true },
        ...(action === "issue-red"
          ? [
              {
                label: "蓝票号码",
                value: row.docs.find((doc) => doc.docKind === "blue")?.invoiceNo ?? "—",
              },
            ]
          : []),
        ...(action === "issue" || action === "issue-red"
          ? [{ label: "本次发票号码", value: draft.invoiceNo || "—" }]
          : []),
      ],
      checkLabel: "我已核对当前申请、发票信息和处理内容",
      confirmText: action ? `确认${invoiceActions[action]}` : "确认",
      danger: action === "reject" || action === "issue-red",
    };
  const update = (key: keyof InvoiceDraft, value: string | null) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setInput({ checked: false, typed: "" });
  };
  const close = () => {
    if (!intent.pending && !busy && !reading.current) setAction(undefined);
  };
  const reload = async (signal: AbortSignal) => {
    await refresh(signal);
    if (alive.current && !signal.aborted) {
      setStale(false);
      setInput({ checked: false, typed: "" });
    }
  };
  async function submit() {
    if (
      !action ||
      !available ||
      stale ||
      busy ||
      intent.pending ||
      !confirmReady(spec, input.stamp === confirmation ? input : { checked: false, typed: "" })
    )
      return;
    let command;
    try {
      command = invoiceCommand(row, action, draft);
    } catch {
      setNotice("请核对票号、文件、快递或驳回原因等必填信息");
      return;
    }
    if (
      needsDictionary &&
      (!dictionaries.data ||
        dictionaries.isError ||
        !dictionaries.data.items.some(
          (item) =>
            item.code === (action === "reject" ? draft.reasonCode : draft.expressCompanyCode),
        ))
    ) {
      setNotice("请从当前有效字典选择原因或快递公司");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = await intent.submit(
        action,
        [row.invoiceRequestId, stamp, command],
        async (key, signal) => {
          try {
            // typed写口没有lockVersion；写前真实GET核当前版本/完整确认事实，不添加伪字段。
            const current = await api.get(row.invoiceRequestId, signal);
            signal.throwIfAborted();
            if (
              invoiceStamp(current) !== stamp ||
              !allowedInvoiceActions(current, access).includes(command.action)
            )
              throw new InvoiceFailure("VERSION_CONFLICT", 409);
            await api.write(row.invoiceRequestId, command, key, signal);
          } catch (error) {
            if (invoiceNeedsReload(error) && !signal.aborted && alive.current) {
              setStale(true);
              setInput({ checked: false, typed: "" });
              try {
                await reload(signal);
              } catch {
                /* 读取失败保持停写。 */
              }
            }
            throw error;
          }
          if (!signal.aborted && alive.current) {
            changed();
            setStale(true);
          }
          try {
            await reload(signal);
          } catch {
            if (alive.current && !signal.aborted)
              setNotice("操作已提交，详情读取失败，请重新读取；不要重复提交");
          }
          return true;
        },
      );
      if (outcome && alive.current) {
        setAction(undefined);
        setDraft(emptyInvoiceDraft());
      }
    } catch (error) {
      if (alive.current) setNotice(invoiceError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function manualReload() {
    if (intent.pending || busy || reading.current) return;
    const controller = new AbortController();
    reading.current = controller;
    setBusy(true);
    try {
      await reload(controller.signal);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(invoiceError(error));
    } finally {
      if (reading.current === controller) reading.current = undefined;
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      {notice && !action ? <Alert type="warning" title={notice} /> : null}
      {stale ? (
        <Alert
          type="warning"
          title="当前详情已失效，请重新读取并核对后处理"
          action={
            <Button disabled={busy} onClick={() => void manualReload()}>
              重新读取
            </Button>
          }
        />
      ) : null}
      <Space wrap>
        {actions.map((next) => (
          <Button
            key={next}
            type={next === "issue" ? "primary" : "default"}
            danger={next === "reject"}
            disabled={busy || stale}
            onClick={() => {
              setAction(next);
              setDraft(emptyInvoiceDraft());
              setInput({ checked: false, typed: "" });
              setNotice(undefined);
            }}
          >
            {invoiceActions[next]}
          </Button>
        ))}
      </Space>
      {!actions.length ? <p>当前没有可执行动作，以服务端状态与当前权限为准。</p> : null}
      <Modal
        open={!!action}
        title={spec.title}
        footer={null}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        onCancel={close}
        destroyOnHidden
      >
        {action ? (
          <>
            {action === "issue" || action === "issue-red" ? (
              <>
                <label>
                  发票号码
                  <Input
                    aria-label="发票号码"
                    value={draft.invoiceNo}
                    maxLength={20}
                    disabled={busy}
                    onChange={(event) => update("invoiceNo", event.target.value)}
                  />
                </label>
                <label>
                  发票代码（8位票号必填）
                  <Input
                    aria-label="发票代码"
                    value={draft.invoiceCode}
                    maxLength={12}
                    disabled={busy}
                    onChange={(event) => update("invoiceCode", event.target.value)}
                  />
                </label>
                {action === "issue-red" || row.medium === "electronic" ? (
                  <InvoiceUpload
                    key={`${row.invoiceRequestId}:${action}`}
                    services={services}
                    entityId={row.entity.entityId}
                    red={action === "issue-red"}
                    disabled={busy}
                    onChange={(id) => update("fileId", id)}
                  />
                ) : (
                  <label>
                    运单号
                    <Input
                      aria-label="运单号"
                      value={draft.trackingNo}
                      maxLength={20}
                      disabled={busy}
                      onChange={(event) => update("trackingNo", event.target.value)}
                    />
                  </label>
                )}
              </>
            ) : null}
            {needsDictionary ? (
              <label>
                {action === "reject" ? "驳回原因" : "快递公司"}
                <Select
                  style={{ width: "100%" }}
                  aria-label={action === "reject" ? "驳回原因" : "快递公司"}
                  value={
                    (action === "reject" ? draft.reasonCode : draft.expressCompanyCode) || undefined
                  }
                  disabled={busy || dictionaries.isError}
                  loading={dictionaries.isPending}
                  options={dictionaries.data?.items.map((item) => ({
                    value: item.code,
                    label: item.name,
                  }))}
                  onChange={(value) =>
                    update(action === "reject" ? "reasonCode" : "expressCompanyCode", value)
                  }
                />
              </label>
            ) : null}
            {dictionaries.isError && needsDictionary ? (
              <Alert
                type="warning"
                title="字典读取失败，请重试后选择"
                action={<Button onClick={() => void dictionaries.refetch()}>重试字典</Button>}
              />
            ) : null}
            {action === "reject" || action === "issue-red" ? (
              <label>
                {action === "reject" ? "驳回说明（必填）" : "红冲说明"}
                <Input.TextArea
                  aria-label="处理说明"
                  value={draft.note}
                  maxLength={action === "reject" ? 200 : 100}
                  disabled={busy}
                  onChange={(event) => update("note", event.target.value)}
                />
              </label>
            ) : null}
            <ConfirmPanel
              spec={spec}
              input={
                available && !stale && input.stamp === confirmation
                  ? input
                  : { checked: false, typed: "" }
              }
              onInputChange={(next) => {
                if (available && !stale) setInput({ ...next, stamp: confirmation });
              }}
              submitting={busy}
              notice={notice ? { tone: "warning", message: notice } : undefined}
              onCancel={close}
              onConfirm={() => void submit()}
            />
            {stale ? (
              <Button disabled={busy} onClick={() => void manualReload()}>
                重新读取当前详情
              </Button>
            ) : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}
