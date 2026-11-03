import { useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useReachBottom } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Chip } from "@/components/Chip";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { ListFooter } from "@/components/ListFooter";
import { DeliveryEmpty, DeliveryState } from "../../order/components/ui";
import type { useDeliveryResource } from "../../order/components/resource";
import {
  methodLabels,
  takedownStatusLabel,
  moreTakedowns,
  readTakedowns,
  takedownBody,
  takedownItems,
  visibleTakedowns,
  type LifecycleApi,
  type Method,
  type TakedownCard,
  type TakedownState,
  type TaskTab,
  type TakedownTab,
} from "./lifecycle";
type Resource = ReturnType<typeof useDeliveryResource<TakedownState>>;
export function TakedownTasks({
  api,
  resource: r,
  tab,
  orderId,
  targetId,
}: {
  api: LifecycleApi;
  resource: Resource;
  tab: TaskTab;
  orderId?: string;
  targetId?: string;
}) {
  const [selected, setSelected] = useState<TakedownCard | null>(null),
    [method, setMethod] = useState<Method | null>(null),
    [checked, setChecked] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const selection = useRef(0),
    activeWrite = useRef(false),
    data = r.data;
  const reload = async (current: () => boolean) => {
    const next = await readTakedowns(api, tab, orderId, targetId, current);
    r.replace(next, current);
    return next;
  };
  const more = (kind: TakedownTab) =>
    r.run(null, async (current) => {
      if (!data) return;
      const part = await moreTakedowns(api, data[kind], kind, orderId);
      r.replace({ ...data, [kind]: part }, current);
    });
  useReachBottom(() => {
    const kind = data?.pending.page?.hasMore ? "pending" : data?.done.page?.hasMore ? "done" : null;
    if (kind) more(kind);
  });
  const send = () =>
    r.run(null, async (current) => {
      const body = selected && takedownBody(selected, method);
      if (!selected || !body || !checked) return;
      activeWrite.current = true;
      const chosen = selected;
      try {
        await api.confirmTakedown(
          chosen.takedownTaskId,
          body,
          r.intent("takedown-confirm", {
            id: chosen.takedownTaskId,
            body,
            selection: selection.current,
          }),
        );
        if (!current()) return;
        await reload(current);
        if (current()) {
          setSelected(null);
          void Taro.showToast({ title: "已提交下架确认", icon: "none" });
        }
      } catch (cause) {
        if (!current()) return;
        const latest = await readTakedowns(api, "all", orderId, chosen.takedownTaskId, current);
        if (!current()) return;
        const updated = takedownItems(latest).find(
          (item) => item.takedownTaskId === chosen.takedownTaskId,
        );
        if (updated) setSelected(updated);
        if (
          (cause as { error?: string })?.error === "TAKEDOWN_METHOD_NOT_ALLOWED" ||
          (updated && !updated.allowedMethods.includes(method!))
        ) {
          selection.current++;
          setMethod(null);
          setChecked(false);
        }
        setNotice(cause instanceof Error ? cause.message : "下架确认结果未确认，请刷新后核对");
        await reload(current);
      } finally {
        activeWrite.current = false;
      }
    });
  const body = selected && takedownBody(selected, method);
  return (
    <View className="delivery-stack">
      <View className="delivery-lead">下架任务</View>
      <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
      {targetId &&
      data &&
      !data.pending.error &&
      !data.done.error &&
      !takedownItems(data).some((item) => item.takedownTaskId === targetId) ? (
        <Note>当前门店的此筛选下未找到链接中的下架任务，请核对门店或查看全部任务。</Note>
      ) : null}
      {data?.summaryError ? <LoadError message={data.summaryError} onRetry={r.refresh} /> : null}
      {(["pending", "done"] as const).map((kind) => {
        const part = data?.[kind],
          items = visibleTakedowns(data, kind);
        if (tab !== "all" && (tab === "todo" ? kind !== "pending" : kind !== "done")) return null;
        return (
          <View key={kind} className="delivery-stack">
            {part?.error ? (
              <LoadError
                message={part.error}
                onRetry={part.page ? () => more(kind) : r.refresh}
                retrying={r.busy}
              />
            ) : null}
            {items.map((card) => (
              <Card
                key={`takedown:${card.takedownTaskId}`}
                title={card.dramaTitle}
                extra={<View>{takedownStatusLabel(card.status)}</View>}
              >
                <View className="delivery-stack">
                  <View className="delivery-row">
                    <Cover title={card.dramaTitle} src={card.posterUrl?.url} variant="thumb" />
                    <View>
                      <View>{card.channelAccount.accountName}</View>
                      <View className="delivery-caption">
                        {card.orderNo} · {card.episodeCount} 集
                      </View>
                    </View>
                  </View>
                  {card.takedownTaskId === targetId ? <Note>链接中的下架任务</Note> : null}
                  <DescList
                    items={[
                      { label: "使用期止日", value: card.usageEndDate },
                      { label: "下架截止", value: card.dueDate },
                      {
                        label: "商家确认",
                        value: card.merchantConfirmedAt
                          ? appDateTimeFormat.dateTime(card.merchantConfirmedAt)
                          : "尚未确认",
                      },
                      {
                        label: "后台核查",
                        value: card.checkedAt
                          ? appDateTimeFormat.dateTime(card.checkedAt)
                          : "尚未核查",
                      },
                    ]}
                  />
                  {card.isOverdue ? <Note tone="warning">下架任务已逾期，请尽快处理。</Note> : null}
                  {card.stillOnlineCount > 0 && card.actions.includes("confirm") ? (
                    <Note tone="warning">后台发现作品仍在线，请处理后重新确认。</Note>
                  ) : null}
                  {card.status === "merchant_confirmed" ? (
                    <Note>已收到你的确认，等待后台核查。</Note>
                  ) : null}
                  {card.actions.includes("confirm") ? (
                    <Button
                      block
                      variant="outline"
                      size="sm"
                      disabled={r.busy}
                      onClick={() => {
                        selection.current++;
                        setSelected(card);
                        setMethod(null);
                        setChecked(false);
                        setNotice(null);
                      }}
                    >
                      确认已下架
                    </Button>
                  ) : null}
                </View>
              </Card>
            ))}
            {part?.page && !items.length ? (
              <DeliveryEmpty text={kind === "pending" ? "暂无待下架任务" : "暂无已完成下架任务"} />
            ) : null}
            {part?.page?.hasMore ? (
              <Button block variant="secondary" loading={r.busy} onClick={() => more(kind)}>
                继续查看{kind === "pending" ? "待下架" : "已完成下架"}任务
              </Button>
            ) : part?.page?.items.length ? (
              <ListFooter status="done" />
            ) : null}
          </View>
        );
      })}
      {tab !== "done" && data?.pending.page?.items.length === 0 && data.summary?.nextTakedown ? (
        <Note>
          下一部需下架作品：{data.summary.nextTakedown.dramaTitle}；使用期止日{" "}
          {data.summary.nextTakedown.usageEndDate}，任务将于 {data.summary.nextTakedown.createDate}{" "}
          生成。
        </Note>
      ) : null}
      {selected ? (
        <Sheet
          visible
          title="确认已下架"
          description={`${selected.dramaTitle} · ${selected.channelAccount.accountName}`}
          onClose={() => {
            if (!r.busy && !activeWrite.current) setSelected(null);
          }}
          closeOnOverlayClick={!r.busy}
          footer={
            <Button block loading={r.busy} disabled={!body || !checked} onClick={send}>
              提交下架确认
            </Button>
          }
        >
          <View className="delivery-stack">
            <Note>请选择你在平台完成的处理方式。本次确认提交后，后台仍会核查实际作品状态。</Note>
            <View className="delivery-chips">
              {selected.allowedMethods
                .filter(
                  (item) => item !== "not_published" || selected.basis === "delivered_unverified",
                )
                .map((item) => (
                  <Chip
                    key={item}
                    selected={method === item}
                    disabled={r.busy}
                    onClick={() => {
                      if (!activeWrite.current && method !== item) {
                        selection.current++;
                        setMethod(item);
                        setChecked(false);
                        setNotice(null);
                      }
                    }}
                  >
                    {methodLabels[item]}
                  </Chip>
                ))}
            </View>
            <Checkbox
              checked={checked}
              disabled={r.busy || !body}
              onChange={(value) => {
                if (!activeWrite.current) setChecked(value);
              }}
            >
              我已核对作品和账号，并完成所选处理
            </Checkbox>
            {notice || r.error ? <Note tone="warning">{notice ?? r.error}</Note> : null}
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}
