import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatMoneyFixed } from "@liyoxi/shared/format/money";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Drawer, Input, Modal, Radio, Select, Spin, Table } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { FormField } from "../../../components/FormField";
import { InfoList } from "../../../components/InfoList";
import { PageHeader } from "../../../components/PageHeader";
import {
  QueueWorkbench,
  type QueueActionResult,
  type QueueState,
} from "../../../components/QueueWorkbench";
import { StatusTag } from "../../../components/StatusTag";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { writeQueueSearch } from "../../../lib/queue";
import {
  createReceiptsApi,
  ReceiptFailure,
  type Body,
  type ReceiptRow,
  type ReceiptsApi,
} from "./api";
import { bankConflicts, createReceiptIntent, receivedFen, type BankConflict } from "./model";
import "./receipts.css";
const route = getRouteApi("/orders/receipts");
const ROOT_KEY = ["billing", "receipts"] as const;
interface Controller {
  confirm(checked: readonly string[]): Promise<QueueActionResult>;
  reject(): Promise<QueueActionResult>;
}
function status(value: unknown) {
  if (typeof value !== "string") return "未知状态";
  const entry = statusToneByEnum("transfer_proof.review_status", value)?.admin;
  return entry ? <StatusTag tone={entry.tone}>{entry.label}</StatusTag> : value;
}
export function ReceiptsPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    search = route.useSearch(),
    navigate = route.useNavigate();
  const api = useMemo(() => createReceiptsApi(services), [services]);
  const tab = search.tab === "processed_today" ? "processed_today" : "pending";
  const canConfirm = useCan("finance.receipt.confirm"),
    canReject = useCan("finance.receipt.reject");
  const controllers = useRef(new Map<string, Controller>());
  const register = useCallback((id: string, controller: Controller | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const list = useQuery({
    queryKey: [...ROOT_KEY, "list", tab, search.q],
    queryFn: () => api.list(tab, search.q),
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...ROOT_KEY, "summary", search.q],
    queryFn: () => api.summary(search.q),
    ...QUEUE_QUERY,
  });
  const refresh = () => {
    void services.queryClient.invalidateQueries({ queryKey: ROOT_KEY });
  };
  const queue: QueueState<ReceiptRow> = list.isPending
    ? { status: "loading" }
    : list.isError
      ? { status: "error", message: list.error.message }
      : { status: "success", items: list.data.items };
  return (
    <div className="receipts-page">
      <PageHeader
        title="对公收款确认"
        subtitle="逐条核对银行到账，确认后开通套餐并入账"
        extra={summary.data ? `待确认 ${summary.data.pending} 笔` : undefined}
      />
      {summary.isError ? <Alert type="warning" title="页签计数暂未刷新" /> : null}
      <QueueWorkbench
        label="对公收款队列"
        tabs={[
          { key: "pending", label: "待确认", count: summary.data?.pending },
          { key: "processed_today", label: "今日已处理", count: summary.data?.processed_today },
        ]}
        search={search}
        defaultTab="pending"
        onSearchChange={(next) => void navigate({ search: writeQueueSearch(next) })}
        searchPlaceholder="搜索主体、付款单号"
        queue={queue}
        onRetry={() => void list.refetch()}
        onQueueChanged={refresh}
        notifySuccess={showSuccessNotice}
        itemKey={(item) => item.transferProofId}
        renderItem={(item) => ({
          title: item.entity.name,
          line: `${item.orderNo} · ${formatMoneyFixed(item.amountFen)}`,
          meta: `${appDateTimeFormat.dateTime(item.uploadedAt)} · 第 ${item.uploadNo} 次上传`,
          tag: status(item.reviewStatus),
        })}
        detailHeader={(item) => ({
          title: item.entity.name,
          description: `付款单 ${item.orderNo}`,
          status: status(item.reviewStatus),
        })}
        detail={(item) => (
          <ReceiptReview
            key={item.transferProofId}
            id={item.transferProofId}
            api={api}
            register={register}
            canConfirm={canConfirm}
            canReject={canReject}
          />
        )}
        checklist={
          tab === "pending"
            ? {
                title: "人工核对",
                items: [{ key: "bank_statement_checked", label: "已在银行账户中查到该笔到账流水" }],
              }
            : undefined
        }
        actions={[
          {
            key: "confirm",
            label: "确认到账",
            kind: "primary",
            needsChecklist: true,
            hidden: !canConfirm || tab !== "pending",
            run: ({ item, checked }) =>
              controllers.current.get(item.transferProofId)?.confirm(checked) ??
              Promise.resolve({ outcome: "failed", message: "详情尚未加载，请稍后重试" }),
          },
          {
            key: "reject",
            label: "驳回凭证",
            kind: "reject",
            hidden: !canReject || tab !== "pending",
            run: ({ item }) =>
              controllers.current.get(item.transferProofId)?.reject() ??
              Promise.resolve({ outcome: "failed", message: "详情尚未加载，请稍后重试" }),
          },
        ]}
        readOnlyHint={!canConfirm && !canReject ? "当前账号仅可查看" : undefined}
        settled={(item) =>
          item.reviewStatus === "accepted"
            ? { tone: "success", message: "已确认到账" }
            : item.reviewStatus === "rejected"
              ? { tone: "danger", message: "已驳回凭证" }
              : undefined
        }
        empty={{ title: tab === "pending" ? "暂无待确认凭证" : "今日暂无已处理凭证" }}
      />
    </div>
  );
}
function ReceiptReview({
  id,
  api,
  register,
  canConfirm,
  canReject,
}: {
  id: string;
  api: ReceiptsApi;
  register(id: string, controller: Controller | null): void;
  canConfirm: boolean;
  canReject: boolean;
}) {
  const query = useQuery({
    queryKey: [...ROOT_KEY, "detail", id],
    queryFn: () => api.detail(id),
    ...DETAIL_QUERY,
  });
  const detail = query.data;
  const [serial, setSerial] = useState(""),
    [amount, setAmount] = useState(""),
    [bank, setBank] = useState<string | undefined>();
  const [conflicts, setConflicts] = useState<BankConflict[] | null>(null),
    [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false),
    [reason, setReason] = useState<string | null>(null),
    [note, setNote] = useState(""),
    [rejectBusy, setRejectBusy] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false),
    [image, setImage] = useState<{ url: string; zoom: number; rotate: number } | null>(null),
    [imageBusy, setImageBusy] = useState(false);
  const mounted = useRef(true),
    running = useRef(false),
    imageGeneration = useRef(0),
    rejectResolve = useRef<((result: QueueActionResult) => void) | null>(null);
  const confirmation = useMemo(
    () =>
      createReceiptIntent("receipt-confirm", (body: Body<"admin.transferProof.confirm">, key) =>
        api.confirm(id, body, key),
      ),
    [id, api],
  );
  const rejection = useMemo(
    () =>
      createReceiptIntent("receipt-reject", (body: Body<"admin.transferProof.reject">, key) =>
        api.reject(id, body, key),
      ),
    [id, api],
  );
  const reasons = useQuery({
    queryKey: [...ROOT_KEY, "reasons"],
    queryFn: () => api.dictionary("reject_reason", "transfer"),
    ...DICT_QUERY,
  });
  const banks = useQuery({
    queryKey: [...ROOT_KEY, "banks"],
    queryFn: () => api.dictionary("bank"),
    enabled: conflicts !== null,
    ...DICT_QUERY,
  });
  const order = useQuery({
    queryKey: [...ROOT_KEY, "order", detail?.paymentOrderId],
    queryFn: () => api.order(detail!.paymentOrderId),
    enabled: orderOpen && Boolean(detail),
    ...DETAIL_QUERY,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      rejectResolve.current?.({ outcome: "failed", message: "已离开该凭证" });
    };
  }, []);
  const failure = useCallback(
    (e: unknown): QueueActionResult => {
      if (
        e instanceof ReceiptFailure &&
        ["VERSION_CONFLICT", "STATE_NOT_ALLOWED"].includes(e.failure.symbol)
      ) {
        void query.refetch();
        return { outcome: "conflict" };
      }
      return {
        outcome: "failed",
        message: e instanceof Error ? e.message : "暂未处理成功，请重试",
      };
    },
    [query],
  );
  const confirm = useCallback(
    async (checked: readonly string[]): Promise<QueueActionResult> => {
      if (
        running.current ||
        !mounted.current ||
        !detail ||
        !canConfirm ||
        !detail.actions.includes("confirm")
      )
        return { outcome: "failed", message: "当前凭证不可确认" };
      const receivedAmountFen = receivedFen(amount);
      if (!serial.trim() || serial.trim().length > 64 || receivedAmountFen === null) {
        setError("请填写银行流水号与实际到账金额（元）");
        return { outcome: "failed", message: "请填写完整的到账信息" };
      }
      if (!checked.includes("bank_statement_checked"))
        return { outcome: "failed", message: "请先核对银行流水" };
      if (conflicts && !bank) return { outcome: "failed", message: "请根据回单选择付款行" };
      running.current = true;
      setError(null);
      try {
        const result = await confirmation.submit({
          lockVersion: detail.lockVersion,
          bankSerialNo: serial.trim(),
          ...(bank ? { payerBankCode: bank } : {}),
          confirm: {
            orderNo: detail.orderNo,
            receivedAmountFen,
            ...(conflicts ? { conflictOrderNos: conflicts.map((v) => v.ref) } : {}),
          },
          confirmChecks: [...checked],
        });
        if (!mounted.current || !result)
          return { outcome: "failed", message: "请查看该凭证的最新结果" };
        return { outcome: "done", message: "已确认到账" };
      } catch (e) {
        if (!mounted.current) return { outcome: "failed", message: "已离开该凭证" };
        const duplicate = bankConflicts(e);
        if (duplicate) {
          setConflicts(duplicate);
          setBank(undefined);
          setError("该流水号已登记，请核对全部冲突付款单并选择付款行");
        }
        return failure(e);
      } finally {
        running.current = false;
      }
    },
    [detail, canConfirm, amount, serial, bank, conflicts, confirmation, failure],
  );
  const reject = useCallback((): Promise<QueueActionResult> => {
    if (running.current || !detail || !canReject || !detail.actions.includes("reject"))
      return Promise.resolve({ outcome: "failed", message: "当前凭证不可驳回" });
    running.current = true;
    setError(null);
    setReason(null);
    setNote("");
    setRejectOpen(true);
    return new Promise((resolve) => {
      rejectResolve.current = resolve;
    });
  }, [detail, canReject]);
  useEffect(() => {
    register(id, { confirm, reject });
    return () => register(id, null);
  }, [id, register, confirm, reject]);
  function closeReject(result: QueueActionResult = { outcome: "failed", message: "已取消驳回" }) {
    if (rejectBusy) return;
    setRejectOpen(false);
    running.current = false;
    rejectResolve.current?.(result);
    rejectResolve.current = null;
  }
  async function submitReject() {
    if (rejectBusy || !detail || !reason || !note.trim()) return;
    setRejectBusy(true);
    setError(null);
    try {
      const result = await rejection.submit({
        lockVersion: detail.lockVersion,
        reasonCode: reason,
        note: note.trim(),
      });
      if (mounted.current && result) {
        setRejectOpen(false);
        running.current = false;
        rejectResolve.current?.({ outcome: "done", message: "已驳回凭证" });
        rejectResolve.current = null;
      }
    } catch (e) {
      if (mounted.current) {
        const result = failure(e);
        if (result.outcome === "conflict") {
          setRejectOpen(false);
          running.current = false;
          rejectResolve.current?.(result);
          rejectResolve.current = null;
        } else setError(result.outcome === "failed" ? result.message : "暂未驳回");
      }
    } finally {
      if (mounted.current) setRejectBusy(false);
    }
  }
  async function openImage() {
    if (!detail || imageBusy) return;
    const own = ++imageGeneration.current;
    setImageBusy(true);
    setError(null);
    try {
      const signed = await api.image(detail.fileId);
      if (mounted.current && own === imageGeneration.current)
        setImage({ url: signed.url, zoom: 1, rotate: 0 });
    } catch (e) {
      if (mounted.current && own === imageGeneration.current)
        setError(e instanceof Error ? e.message : "凭证地址暂未取得，请重试");
    } finally {
      if (mounted.current && own === imageGeneration.current) setImageBusy(false);
    }
  }
  const edit = (change: () => void) => {
    change();
    setConflicts(null);
    setBank(undefined);
    setError(null);
  };
  if (query.isPending) return <Spin aria-label="正在加载凭证" />;
  if (query.isError || !detail)
    return (
      <Alert
        type="error"
        title={query.error?.message ?? "暂无凭证详情"}
        action={<Button onClick={() => void query.refetch()}>重新加载</Button>}
      />
    );
  return (
    <div className="receipts-detail">
      <section>
        <h3 className="lyx-section-title">付款单信息</h3>
        <InfoList
          labelWidth={84}
          items={[
            {
              label: "付款单号",
              value: (
                <Button type="link" onClick={() => setOrderOpen(true)}>
                  {detail.orderNo}
                </Button>
              ),
            },
            { label: "购买内容", value: detail.order.title },
            {
              label: "应付金额",
              value: <span className="lyx-num">{formatMoneyFixed(detail.amountFen)}</span>,
            },
            { label: "上传人", value: detail.uploadedBy.name ?? "—" },
            { label: "上传时间", value: appDateTimeFormat.dateTime(detail.uploadedAt) },
            { label: "归属门店", value: detail.entity.primaryStoreName ?? "—" },
          ]}
        />
        {detail.bizHints.map((hint) => (
          <Alert key={hint.code} type="info" title={hint.text} />
        ))}
      </section>
      <section>
        <h3 className="lyx-section-title">转账凭证</h3>
        <Button loading={imageBusy} onClick={() => void openImage()}>
          查看凭证原图
        </Button>
        <p className="receipts-muted">未配置识别，请以银行账户的真实流水为准</p>
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={detail.checks}
          columns={[
            { title: "核对项目", dataIndex: "key" },
            { title: "凭证识别", dataIndex: "proofValue" },
            { title: "订单信息", dataIndex: "orderValue" },
            { title: "比对结果", dataIndex: "result" },
          ]}
          locale={{ emptyText: "暂无自动识别结果" }}
        />
      </section>
      {detail.reviewStatus === "pending" && canConfirm && detail.actions.includes("confirm") ? (
        <section aria-label="确认到账信息">
          <h3 className="lyx-section-title">确认到账</h3>
          <div className="receipts-form">
            <FormField label="银行流水号" value={serial} maxLength={64}>
              {(props) => (
                <Input
                  {...props}
                  value={serial}
                  maxLength={64}
                  onChange={(e) => edit(() => setSerial(e.target.value))}
                  placeholder="填写银行真实流水号"
                />
              )}
            </FormField>
            <FormField label="实际到账金额（元）">
              {(props) => (
                <Input
                  {...props}
                  value={amount}
                  inputMode="decimal"
                  onChange={(e) => edit(() => setAmount(e.target.value))}
                  placeholder="请按银行到账填写"
                />
              )}
            </FormField>
            {conflicts ? (
              <>
                <Alert
                  type="warning"
                  title="流水号已登记"
                  description={
                    <ul>
                      {conflicts.map((conflict) => (
                        <li key={conflict.ref}>
                          {conflict.ref} · {conflict.payerBank?.name ?? "未登记付款行"}
                        </li>
                      ))}
                    </ul>
                  }
                />
                <FormField label="付款行">
                  {(props) => (
                    <Select
                      {...props}
                      aria-label="付款行"
                      loading={banks.isPending}
                      value={bank}
                      onChange={setBank}
                      placeholder="按银行回单选择付款行"
                      options={banks.data?.items
                        .filter((v) => v.isEnabled)
                        .map((v) => ({ value: v.code, label: v.name }))}
                    />
                  )}
                </FormField>
                {banks.isError ? <Alert type="error" title="付款行字典暂未加载" /> : null}
              </>
            ) : null}
          </div>
        </section>
      ) : null}
      {detail.rejectNote ? (
        <Alert
          type="error"
          title={detail.rejectReason?.name ?? "已驳回"}
          description={detail.rejectNote}
        />
      ) : null}
      {error && !rejectOpen ? <Alert type="error" title={error} /> : null}
      <Modal
        title="驳回转账凭证"
        open={rejectOpen}
        onCancel={() => closeReject()}
        destroyOnHidden
        footer={
          <>
            <Button disabled={rejectBusy} onClick={() => closeReject()}>
              取消
            </Button>
            <Button
              type="primary"
              danger
              loading={rejectBusy}
              disabled={!reason || !note.trim() || reasons.isPending || reasons.isError}
              onClick={() => void submitReject()}
            >
              确认驳回
            </Button>
          </>
        }
      >
        <Radio.Group
          aria-label="驳回原因"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <div className="receipts-reasons">
            {reasons.data?.items
              .filter((v) => v.isEnabled)
              .map((v) => (
                <Radio key={v.code} value={v.code}>
                  {v.name}
                </Radio>
              ))}
          </div>
        </Radio.Group>
        {reasons.isError ? <Alert type="error" title="驳回原因暂未加载" /> : null}
        <FormField label="驳回说明" value={note} maxLength={200}>
          {(props) => (
            <Input.TextArea
              {...props}
              rows={3}
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="请填写商家可以据此处理的说明"
            />
          )}
        </FormField>
        {error ? <Alert type="error" title={error} /> : null}
      </Modal>
      <Drawer title="付款单详情" open={orderOpen} onClose={() => setOrderOpen(false)} size="large">
        {order.isPending ? (
          <Spin />
        ) : order.isError ? (
          <Alert type="error" title={order.error.message} />
        ) : order.data ? (
          <InfoList
            labelWidth={110}
            items={[
              { label: "付款单号", value: order.data.orderNo },
              { label: "主体", value: order.data.entity.name },
              { label: "内容", value: order.data.title },
              { label: "应付金额", value: formatMoneyFixed(order.data.amountFen) },
              { label: "已付金额", value: formatMoneyFixed(order.data.paidAmountFen) },
              {
                label: "状态",
                value:
                  order.data.statusNote ??
                  (typeof order.data.status === "string" ? order.data.status : "未知状态"),
              },
              { label: "报价说明", value: order.data.formula?.text ?? "—" },
              { label: "收款账户", value: order.data.bankAccount?.accountNoMask ?? "—" },
              { label: "开通结果", value: order.data.effectNote ?? "—" },
            ]}
          />
        ) : null}
      </Drawer>
      <Modal
        title="转账凭证原图"
        open={image !== null}
        onCancel={() => {
          imageGeneration.current++;
          setImage(null);
        }}
        width={900}
        footer={
          image ? (
            <>
              <Button onClick={() => setImage((v) => (v ? { ...v, zoom: v.zoom + 0.25 } : v))}>
                放大
              </Button>
              <Button
                onClick={() =>
                  setImage((v) => (v ? { ...v, zoom: Math.max(0.25, v.zoom - 0.25) } : v))
                }
              >
                缩小
              </Button>
              <Button onClick={() => setImage((v) => (v ? { ...v, rotate: v.rotate + 90 } : v))}>
                旋转
              </Button>
              <Button onClick={() => void openImage()}>重新获取地址</Button>
            </>
          ) : null
        }
        destroyOnHidden
      >
        {image ? (
          <div className="receipts-image">
            <img
              src={image.url}
              alt="银行转账凭证原图"
              onError={() => setError("凭证地址可能已过期，请重新获取地址")}
              style={{ transform: `scale(${image.zoom}) rotate(${image.rotate}deg)` }}
            />
          </div>
        ) : null}
        {error ? <Alert type="warning" title={error} /> : null}
      </Modal>
    </div>
  );
}
