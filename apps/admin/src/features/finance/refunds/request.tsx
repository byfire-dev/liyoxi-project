import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Select, Spin } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import type { AppServices } from "../../../app/services";
import {
  ConfirmPanel,
  confirmReady,
  type ConfirmInput,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { InfoList } from "../../../components/InfoList";
import { AccessContext } from "../../../lib/permissions";
import { moneyText } from "../payments/model";
import { createRefundRequestApi, RefundRequestFailure, refundRequestError } from "./request-api";
import {
  canRequestRefund,
  createRefundRequestIntent,
  eligibleRefundRules,
  refundRequestBody,
  refundRuleLabels,
  refundSnapshotStamp,
  type RefundRule,
  type RefundTarget,
} from "./request-model";

const unsupported: Readonly<Record<string, string>> = {
  topup_not_refundable: "积分加购不支持现金退款",
  upgrade_refund_source_first: "请先核对升级来源周期退款",
  not_fulfilled: "付款尚未完成履约",
  not_paid: "付款尚未成功入账",
  already_refunded: "付款已有退款",
  open_request_exists: "已有未关闭的退款申请",
};
const ineligible: Readonly<Record<string, string>> = {
  outside_window: "已过窗口",
  points_used: "积分已使用",
  term_upgraded: "周期已升级",
  qualification_not_dead: "资质尚未终审不通过",
  term_not_refundable: "周期当前不可退款",
};
export function RefundRequestDialog({
  target,
  services,
  scope,
  onClose,
  onCreated,
}: {
  target: RefundTarget;
  services: AppServices;
  scope: string;
  onClose(): void;
  onCreated(): void;
}) {
  const access = useContext(AccessContext),
    api = useMemo(() => createRefundRequestApi(services), [services]),
    intent = useMemo(() => createRefundRequestIntent(), []),
    alive = useRef(true),
    reading = useRef<AbortController | undefined>(undefined),
    cache = useQueryClient();
  const [selectedRule, setRule] = useState<RefundRule>(),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [input, setInput] = useState<ConfirmInput & { stamp?: string }>({ checked: false, typed: "" }),
    [readingCreated, setReadingCreated] = useState(false),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [notice, setNotice] = useState<string>(),
    [createdId, setCreatedId] = useState<string>(),
    [created, setCreated] = useState<Awaited<ReturnType<typeof api.get>>>();
  const permitted = canRequestRefund(access),
    reasons = useQuery({
      queryKey: ["finance", scope, "refund-request-reasons"],
      queryFn: ({ signal }) => api.reasons(signal),
      enabled: permitted && !createdId,
      retry: false,
    });
  const quoteKey = [
      "finance",
      scope,
      "refund-request-quote",
      target.paymentOrderId,
      target.paymentTransactionId,
      selectedRule,
    ] as const,
    quoted = useQuery({
      queryKey: quoteKey,
      queryFn: ({ signal }) => api.snapshot(target, selectedRule, signal),
      enabled: permitted && !createdId,
      retry: false,
      refetchOnWindowFocus: false,
    }),
    snapshot = quoted.isError ? undefined : quoted.data,
    rule = selectedRule ?? snapshot?.quote.suggestedRule ?? undefined,
    loading = quoted.isFetching || readingCreated;
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      reading.current?.abort();
    };
  }, [intent]);
  async function load() {
    if (intent.pending || busy) return;
    setInput({ checked: false, typed: "" });
    setStale(true);
    setNotice(undefined);
    const result = await quoted.refetch();
    if (alive.current && !result.isError) setStale(false);
  }
  const rules = snapshot ? eligibleRefundRules(snapshot.quote, access) : [],
    available = permitted && !!rule && rules.includes(rule) && !createdId && !loading && !stale;
  const stamp = JSON.stringify([snapshot, rule, reason, note]);
  const spec: ConfirmSpec = {
    title: "申请现金退款",
    description: "这里只发起申请并暂停相应周期，须由另一人审批后执行；不代表已经退款。",
    echo: [
      { label: "付款单", value: target.orderNo },
      { label: "商家", value: snapshot?.order.entity.name ?? target.entityName },
      { label: "退款规则", value: rule ? refundRuleLabels[rule] : "请选择可用规则" },
      {
        label: "实际可退金额",
        value: snapshot ? moneyText(snapshot.quote.refundableFen) : "—",
        emphasis: true,
      },
      {
        label: "执行方式预览",
        value: snapshot?.quote.routePreview === "wechat_original" ? "微信原路" : "线下转账",
      },
      {
        label: "将回收积分",
        value: snapshot ? String(snapshot.quote.sideEffects.revokePoints) : "—",
      },
      {
        label: "将取消发放计划",
        value: snapshot ? String(snapshot.quote.sideEffects.cancelSchedules) : "—",
      },
      {
        label: "将暂停加购积分",
        value: snapshot ? String(snapshot.quote.sideEffects.addonWillSuspend) : "—",
      },
      {
        label: "后续周期立即接续",
        value: snapshot?.quote.sideEffects.nextTermWillStartNow ? "是" : "否",
      },
      { label: "蓝票需红冲", value: snapshot?.quote.invoice.needsRedInvoice ? "是" : "否" },
    ],
    checkLabel: "我已核对退款规则、金额、周期与权益影响",
    confirmText: "确认申请现金退款",
    danger: true,
    sensitive: { label: "请输入付款单号后4位", expected: target.orderNo.slice(-4) },
  };
  const close = () => {
    if (!busy && !intent.pending) onClose();
  };
  async function readCreated(id: string) {
    if (busy || loading || reading.current) return;
    const controller = new AbortController();
    reading.current = controller;
    setReadingCreated(true);
    try {
      const row = await api.get(target, id, controller.signal);
      if (alive.current && !controller.signal.aborted) {
        setCreatedId(id);
        setCreated(row);
        setNotice(undefined);
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(refundRequestError(error));
    } finally {
      if (reading.current === controller) reading.current = undefined;
      if (alive.current && !controller.signal.aborted) setReadingCreated(false);
    }
  }
  async function submit() {
    if (
      !available ||
      !snapshot ||
      !rule ||
      busy ||
      intent.pending ||
      !confirmReady(spec, input.stamp === stamp ? input : { checked: false, typed: "" })
    )
      return;
    let body: ReturnType<typeof refundRequestBody>;
    try {
      body = refundRequestBody(snapshot, rule, reason, note, access);
      if (!reasons.data?.items.some((item) => item.code === body.reasonCode) || reasons.isError)
        throw new Error("原因未就绪");
    } catch {
      setNotice("请从当前有效字典选择原因，并核对规则和必填说明");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await intent.submit([target.paymentOrderId, body], async (key, signal) => {
        await cache.cancelQueries({ queryKey: quoteKey, exact: true });
        signal.throwIfAborted();
        const fresh = await api.snapshot(target, rule, signal);
        signal.throwIfAborted();
        if (
          refundSnapshotStamp(fresh) !== refundSnapshotStamp(snapshot) ||
          !eligibleRefundRules(fresh.quote, access).includes(rule)
        ) {
          if (alive.current) {
            cache.setQueryData(quoteKey, fresh);
            setInput({ checked: false, typed: "" });
            setStale(true);
          }
          throw new RefundRequestFailure("PRECONDITION_CHANGED", 409);
        }
        const response = await api.create(target, body, key, signal);
        signal.throwIfAborted();
        if (!alive.current) return;
        setCreatedId(response.refundRequestId);
        setStale(true);
        setInput({ checked: false, typed: "" });
        try {
          const row = await api.get(target, response.refundRequestId, signal);
          signal.throwIfAborted();
          if (alive.current) {
            setCreated(row);
            onCreated();
          }
        } catch {
          if (alive.current && !signal.aborted)
            setNotice("申请已提交，实际详情读取失败；请重新读取，不要重复申请");
        }
      });
    } catch (error) {
      if (alive.current) {
        setNotice(refundRequestError(error));
        if (error instanceof RefundRequestFailure && error.status === 409) {
          setStale(true);
          setInput({ checked: false, typed: "" });
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="申请现金退款"
      open
      footer={null}
      width={620}
      onCancel={close}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      destroyOnHidden
    >
      {!permitted ? <Alert type="warning" title="当前权限不可申请现金退款" /> : null}
      {notice ? <Alert type="warning" title={notice} /> : null}
      {quoted.isError && !createdId ? (
        <Alert type="warning" title={refundRequestError(quoted.error)} />
      ) : null}
      {loading ? <Spin aria-label="现金退款试算加载中" /> : null}
      {createdId ? (
        <>
          {created ? (
            <>
              <Alert type="success" title={`已读取退款申请 ${created.requestNo}`} />
              <InfoList
                items={[
                  { label: "退款单号", value: created.requestNo },
                  {
                    label: "状态",
                    value: created.status === "pending_approval" ? "待异人审批" : created.status,
                  },
                  { label: "申请金额", value: moneyText(created.amountFen) },
                ]}
              />
              <a
                className="lyx-link"
                href={`/finance/refunds?refundRequestId=${encodeURIComponent(created.refundRequestId)}`}
              >
                查看退款申请与后续处理
              </a>
            </>
          ) : (
            <Button disabled={busy || loading} onClick={() => void readCreated(createdId)}>
              重新读取已提交申请
            </Button>
          )}
          <Button disabled={busy} onClick={close}>
            关闭
          </Button>
        </>
      ) : (
        <>
          <Button disabled={busy || loading} onClick={() => void load()}>
            重新试算并核对
          </Button>
          {snapshot ? (
            <>
              {!snapshot.quote.supported ? (
                <Alert
                  type="info"
                  title={
                    unsupported[snapshot.quote.unsupportedReason ?? ""] ??
                    "当前付款不可申请现金退款"
                  }
                />
              ) : null}
              {snapshot.quote.openRequest ? (
                <Button
                  disabled={busy || loading}
                  onClick={() => void readCreated(snapshot.quote.openRequest!.refundRequestId)}
                >
                  读取已有退款申请 {snapshot.quote.openRequest.requestNo}
                </Button>
              ) : null}
              {snapshot.quote.rules.map((item) => (
                <p key={item.rule}>
                  {refundRuleLabels[item.rule]}：
                  {item.eligible
                    ? "符合"
                    : item.reasons.map((reason) => ineligible[reason]).join("、") || "当前不可用"}
                </p>
              ))}
              <p>
                窗口截止：
                {snapshot.quote.windowDeadline
                  ? appDateTimeFormat.dateTimeFull(snapshot.quote.windowDeadline)
                  : "—"}
                ；积分未使用：{snapshot.quote.unused ? "是" : "否"}
              </p>
              <div style={{ display: "grid", gap: 12 }}>
                <label>
                  退款规则
                  <Select
                    aria-label="退款规则"
                    style={{ width: "100%" }}
                    value={rule}
                    disabled={busy || loading}
                    options={rules.map((value) => ({ value, label: refundRuleLabels[value] }))}
                    onChange={(value) => {
                      setRule(value);
                      setInput({ checked: false, typed: "" });
                      setStale(false);
                    }}
                  />
                </label>
                <label>
                  退款原因
                  <Select
                    aria-label="退款原因"
                    style={{ width: "100%" }}
                    value={reason || undefined}
                    disabled={busy || reasons.isPending || reasons.isError}
                    loading={reasons.isPending}
                    options={reasons.data?.items.map((item) => ({
                      value: item.code,
                      label: item.name,
                    }))}
                    onChange={(value) => {
                      setReason(value);
                      setInput({ checked: false, typed: "" });
                    }}
                  />
                </label>
                {reasons.isError ? (
                  <Alert
                    type="warning"
                    title="退款原因读取失败"
                    action={<Button onClick={() => void reasons.refetch()}>重新读取原因</Button>}
                  />
                ) : null}
                <label>
                  申请说明
                  <Input.TextArea
                    aria-label="申请说明"
                    rows={2}
                    maxLength={200}
                    value={note}
                    disabled={busy}
                    onChange={(event) => {
                      setNote(event.target.value);
                      setInput({ checked: false, typed: "" });
                    }}
                  />
                </label>
              </div>
              {stale ? <Alert type="warning" title="确认事实已变化，请重新试算并核对" /> : null}
              <div style={{ paddingTop: "var(--lyx-space-16)" }}>
                <ConfirmPanel
                  spec={spec}
                  input={available && input.stamp === stamp ? input : { checked: false, typed: "" }}
                  onInputChange={(next) => setInput({ ...next, stamp })}
                  submitting={busy || !available || !reason || reasons.isError || !reasons.data}
                  onCancel={close}
                  onConfirm={() => void submit()}
                />
              </div>
            </>
          ) : null}
        </>
      )}
    </Modal>
  );
}
