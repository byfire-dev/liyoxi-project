import { OrderCancelQuoteBodySchema, OrderCancelRequestCreateBodySchema } from "@liyoxi/contract";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Spin } from "antd";
import { useEffect, useMemo, useState } from "react";
import { FormField } from "../../../components/FormField";
import type { OrderDetail } from "./api";
import {
  aftercareError,
  cancelQuoteIdentity,
  manualDeductReady,
  definiteAftercareRejection,
  orderCancelFingerprint,
  type CancelInput,
  type CancelQuote,
  type OrderAftercareApi,
} from "./aftercare-api";
import { createOrderIntent } from "./aftercare-intent";

export const cancelReasons = {
  merchant_request: "商家申请",
  store_closed: "门店停业",
  platform_fault: "平台原因",
} as const;
const stages: Readonly<Record<string, string>> = {
  pending_start: "尚未开工",
  plan_confirm: "方案确认",
  ad_and_sample: "广告与样片制作",
  sample_pending: "样片待确认",
  post_sample: "样片后制作",
  live: "已上线",
  ad_unassigned: "广告待指派",
  ad_in_production: "广告制作中",
};
const blockers: Readonly<Record<string, string>> = {
  item_closed: "项目已关闭",
  live_not_refundable: "已上线项目不支持当前退款",
  item_expired: "使用期已结束",
  in_other_request: "已有其他取消申请",
  ad_confirmed: "广告已确认",
  ad_cancelled: "广告已取消",
  ad_in_use: "广告仍在使用",
};
export function cancelInput(input: {
  reason: CancelInput["reasonCode"];
  itemIds: string[];
  date: string;
  manual: Record<string, { points: number | null; note: string }>;
}): CancelInput | null {
  const parsed = OrderCancelQuoteBodySchema.safeParse({
    reasonCode: input.reason,
    orderItemIds: input.itemIds,
    ...(input.date ? { terminationDate: input.date } : {}),
    ...(Object.values(input.manual).some((row) => row.points !== null)
      ? {
          manualDeducts: Object.entries(input.manual)
            .filter(([id, row]) => input.itemIds.includes(id) && row.points !== null)
            .map(([orderItemId, row]) => ({
              orderItemId,
              deductPoints: row.points,
              deductNote: row.note,
            })),
        }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}
export function QuoteLines({ quote }: { quote: CancelQuote }) {
  return (
    <div className="lyx-order-items" aria-label="取消逐行试算">
      {quote.lines.map((line) => (
        <article className="lyx-order-item" key={line.targetId}>
          <strong>{line.label}</strong>
          <p>
            {line.mode === "release"
              ? "冻结释放"
              : line.mode === "refund"
                ? "已扣退回"
                : "仅终止使用"}{" "}
            · {stages[line.stage] ?? "其他阶段"}
            {line.stepAtSubmit
              ? ` · ${statusToneByEnum("delivery_ticket.step", line.stepAtSubmit)?.admin?.label ?? "其他工单步骤"}`
              : ""}
          </p>
          <p>
            计费 {line.chargePoints} · 已申请 {line.priorRequestedPoints} · 扣除 {line.deductPoints}{" "}
            · 本次退回 {line.refundPoints} 积分
          </p>
          <p>
            比例 {line.ratioBp === null ? "不适用" : `${line.ratioBp / 100}%`}
            {line.deductNote ? ` · 扣除说明：${line.deductNote}` : ""}
          </p>
          <p>
            预计原路 {line.preview.backToOriginal} · 转加购 {line.preview.convertedToAddon} · 失效{" "}
            {line.preview.forfeited}
          </p>
          {line.terminationDate ? <p>使用止日 {line.terminationDate}</p> : null}
        </article>
      ))}
      <strong>
        合计：基数 {quote.totalBasePoints} · 扣除 {quote.totalDeductPoints} · 退回{" "}
        {quote.totalRefundPoints} 积分
      </strong>
      <p>
        预计去向：原路 {quote.destination.backToOriginal} · 转加购{" "}
        {quote.destination.convertedToAddon} · 失效 {quote.destination.forfeited}
        ；当前尚未执行退回。
      </p>
      {quote.blockers.map((row, index) => (
        <Alert
          key={`${row.orderItemId}-${index}`}
          type="warning"
          title={`当前不可申请：${blockers[row.reason] ?? "当前条件不允许"}`}
        />
      ))}
      {quote.needsManualDeduct &&
      quote.lines.some((line) => line.isManualDeduct && !line.deductNote?.trim()) ? (
        <Alert type="warning" title="请补充服务端要求的逐项扣除积分与说明后重新试算" />
      ) : null}
    </div>
  );
}
export function OrderCancelForm({
  order,
  api,
  onClose,
  onChanged,
}: {
  order: OrderDetail;
  api: OrderAftercareApi;
  onClose(): void;
  onChanged(order: OrderDetail): void;
}) {
  const [reason, setReason] = useState<CancelInput["reasonCode"]>("merchant_request"),
    [itemIds, setItemIds] = useState(order.items.map((row) => row.orderItemId)),
    [date, setDate] = useState(""),
    [manual, setManual] = useState<Record<string, { points: number | null; note: string }>>({}),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const input = cancelInput({ reason, itemIds, date, manual });
  const quote = useQuery({
    queryKey: ["order-cancel-quote", order.orderId, order.lockVersion, input],
    enabled: input !== null,
    queryFn: ({ signal }) => {
      if (!input) throw new Error("范围无效");
      return api.quote(order.orderId, input, signal);
    },
    retry: false,
  });
  const workspace = useMemo(
    () =>
      createOrderIntent(
        (signal) => api.get(order.orderId, signal),
        undefined,
        definiteAftercareRejection,
      ),
    [api, order.orderId],
  );
  useEffect(() => {
    workspace.activate();
    return () => workspace.close();
  }, [workspace]);
  const seen =
    quote.data && input
      ? JSON.stringify({
          input,
          note,
          orderVersion: order.lockVersion,
          requests: orderCancelFingerprint(order),
          facts: cancelQuoteIdentity(quote.data),
        })
      : "";
  const body = OrderCancelRequestCreateBodySchema.safeParse(
    input && quote.data ? { ...input, note, expect: quote.data.expect } : null,
  );
  const locked = workspace.locked(),
    accepted = workspace.accepted();
  const sameIntent = !locked || workspace.identity() === seen;
  const ready =
    !!seen &&
    confirmed === seen &&
    sameIntent &&
    !accepted &&
    body.success &&
    !quote.isFetching &&
    !quote.isError &&
    !quote.data?.blockers.length &&
    !!input &&
    !!quote.data &&
    manualDeductReady(quote.data, input);
  const submit = async () => {
    if (!ready || !body.success || !quote.data) return;
    setBusy(true);
    setError(undefined);
    try {
      const value = await workspace.submit(
        seen,
        (fresh) => orderCancelFingerprint(fresh) === orderCancelFingerprint(order),
        (_fresh, key, signal) =>
          api.createCancel(order.orderId, body.data, quote.data!, key, signal),
      );
      if (value) {
        onChanged(value);
        onClose();
      }
    } catch (cause) {
      if (workspace.active()) {
        setError(
          workspace.accepted()
            ? "申请已受理，读取结果失败；请用原意图刷新结果，不会再次提交"
            : aftercareError(cause),
        );
        setConfirmed(undefined);
      }
    } finally {
      if (workspace.active()) setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const fresh = await workspace.refresh();
      if (!fresh) return;
      setConfirmed(undefined);
      onChanged(fresh);
      if (
        workspace.accepted() ||
        !sameIntent ||
        orderCancelFingerprint(fresh) !== orderCancelFingerprint(order)
      )
        onClose();
      else {
        setError("当前事实已刷新，请重新核对试算与确认内容");
        void quote.refetch();
      }
    } catch (cause) {
      if (workspace.active()) setError(aftercareError(cause));
    } finally {
      if (workspace.active()) setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`取消申请 · ${order.orderNo}`}
      footer={null}
      onCancel={() => {
        if (workspace.canClose()) onClose();
      }}
      closable={!busy && !locked}
      keyboard={!busy && !locked}
      mask={{ closable: !busy && !locked }}
      destroyOnHidden
    >
      <div className="lyx-order-form">
        <FormField label="取消原因">
          {(props) => (
            <Select
              {...props}
              value={reason}
              disabled={busy || locked}
              options={Object.entries(cancelReasons).map(([value, label]) => ({ value, label }))}
              onChange={setReason}
            />
          )}
        </FormField>
        <fieldset disabled={busy || locked}>
          <legend>取消剧目范围</legend>
          {order.items.map((row) => (
            <div key={row.orderItemId}>
              <Checkbox
                checked={itemIds.includes(row.orderItemId)}
                onChange={(event) =>
                  setItemIds((old) =>
                    event.target.checked
                      ? [...old, row.orderItemId]
                      : old.filter((id) => id !== row.orderItemId),
                  )
                }
              >
                {row.dramaTitle}
              </Checkbox>
            </div>
          ))}
        </fieldset>
        <FormField label="使用止日（按需填写）">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={date}
              disabled={busy || locked}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </FormField>
        {order.items
          .filter((row) => itemIds.includes(row.orderItemId))
          .map((row) => (
            <details key={row.orderItemId}>
              <summary>{row.dramaTitle} · 手工扣除（服务端要求时填写）</summary>
              <FormField label={`${row.dramaTitle}扣除积分`}>
                {(props) => (
                  <InputNumber
                    {...props}
                    min={0}
                    precision={0}
                    value={manual[row.orderItemId]?.points ?? null}
                    disabled={busy || locked}
                    onChange={(points) =>
                      setManual((old) => ({
                        ...old,
                        [row.orderItemId]: { note: old[row.orderItemId]?.note ?? "", points },
                      }))
                    }
                  />
                )}
              </FormField>
              <FormField
                label={`${row.dramaTitle}扣除说明`}
                value={manual[row.orderItemId]?.note ?? ""}
                maxLength={200}
              >
                {(props) => (
                  <Input
                    {...props}
                    maxLength={200}
                    value={manual[row.orderItemId]?.note ?? ""}
                    disabled={busy || locked}
                    onChange={(event) =>
                      setManual((old) => ({
                        ...old,
                        [row.orderItemId]: {
                          points: old[row.orderItemId]?.points ?? null,
                          note: event.target.value,
                        },
                      }))
                    }
                  />
                )}
              </FormField>
            </details>
          ))}
        {!input ? (
          <Alert type="warning" title="请选择至少一部剧，并核对止日与手工扣除说明" />
        ) : quote.isFetching ? (
          <Spin tip="正在重新试算" />
        ) : quote.isError ? (
          <Alert
            type="error"
            title={aftercareError(quote.error)}
            action={<Button onClick={() => void quote.refetch()}>重新试算</Button>}
          />
        ) : quote.data ? (
          <QuoteLines quote={quote.data} />
        ) : null}
        <FormField
          label="申请说明"
          value={note}
          maxLength={200}
          error={note && note.trim().length < 5 ? "请至少填写5个字" : undefined}
        >
          {(props) => (
            <Input.TextArea
              {...props}
              rows={3}
              maxLength={200}
              value={note}
              disabled={busy || locked}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
        <Checkbox
          disabled={
            busy ||
            accepted ||
            !sameIntent ||
            !body.success ||
            quote.isFetching ||
            !quote.data ||
            !!quote.data.blockers.length ||
            !input ||
            !manualDeductReady(quote.data, input)
          }
          checked={!!seen && confirmed === seen}
          onChange={(event) => setConfirmed(event.target.checked ? seen : undefined)}
        >
          我已核对逐项阶段、扣除及退回积分，申请受理不代表已经退回
        </Checkbox>
        {error ? (
          <Alert
            type="error"
            title={error}
            action={
              <Button disabled={busy} onClick={() => void refresh()}>
                刷新处理结果
              </Button>
            }
          />
        ) : null}
        <div className="lyx-order-form__actions">
          <Button
            disabled={busy || locked}
            onClick={() => {
              if (workspace.canClose()) onClose();
            }}
          >
            关闭
          </Button>
          <Button type="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            提交取消申请
          </Button>
        </div>
      </div>
    </Modal>
  );
}
