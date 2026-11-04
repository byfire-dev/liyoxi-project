import { Alert, Button, Checkbox, Input, Modal } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { writeIntent } from "../../system/staff-access";
import type { OverdueApi, TrackItem } from "./api";
import { canRemind, followBody } from "./model";

export function FollowAction({
  row,
  api,
  refresh,
  close,
  kind,
}: {
  row: TrackItem;
  api: OverdueApi;
  refresh(): Promise<void>;
  close(): void;
  kind: "follow" | "remind";
}) {
  const intent = useMemo(() => writeIntent(`publish-${kind}`), [kind]),
    life = useRef(new AbortController()),
    gate = useRef(false);
  const [content, setContent] = useState(""),
    [next, setNext] = useState(""),
    [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    life.current = new AbortController();
    return () => life.current.abort();
  }, []);
  const readBack = async () => {
    await refresh();
    if (!life.current.signal.aborted) close();
  };
  const submit = async () => {
    if (gate.current || !checked) return;
    gate.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (saved) {
        await readBack();
        return;
      }
      const body =
        kind === "follow"
          ? followBody(row.orderItem.orderItemId, content, next)
          : { scene: "golive" as const, id: row.ticket.deliveryTicketId };
      const result = await intent.run(body, async (key) => {
        if (kind === "follow")
          return api.follow(
            followBody(row.orderItem.orderItemId, content, next),
            key,
            life.current.signal,
          );
        const fresh = await api.list(
          { tab: "all", orderItemId: row.orderItem.orderItemId, page: 1, pageSize: 20 },
          life.current.signal,
        );
        const target = fresh.items.find(
          (item) =>
            item.orderItem.orderItemId === row.orderItem.orderItemId &&
            item.ticket.deliveryTicketId === row.ticket.deliveryTicketId,
        );
        if (!target || !canRemind(target)) throw new Error("当前已不能提醒，请刷新任务后重新确认");
        return api.remind(row.ticket.deliveryTicketId, key, life.current.signal);
      });
      if (!result || life.current.signal.aborted) return;
      setSaved(true);
      await readBack();
    } catch (cause) {
      if (!life.current.signal.aborted)
        setError(cause instanceof Error ? cause.message : "操作没有完成，请重试");
    } finally {
      gate.current = false;
      if (!life.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={kind === "follow" ? "记录跟进" : "提醒商家上线"}
      footer={null}
      onCancel={() => {
        if (!busy) close();
      }}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
    >
      <div className="lyx-overdue-action">
        <p>
          {row.store.storeName ?? "未命名门店"} · {row.orderItem.dramaTitle} · {row.ticket.ticketNo}
        </p>
        {saved ? (
          <Alert
            type="success"
            title="操作已成功，正在重新读取任务"
            description="重新加载只读取最新结果，不会再次提交。"
          />
        ) : kind === "follow" ? (
          <>
            <FormField label="跟进内容" value={content} maxLength={200}>
              {(props) => (
                <Input.TextArea
                  {...props}
                  rows={4}
                  value={content}
                  maxLength={200}
                  disabled={busy}
                  onChange={(event) => setContent(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="下次跟进日期（北京时间 09:00，可不填）">
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={next}
                  disabled={busy}
                  onChange={(event) => setNext(event.target.value)}
                />
              )}
            </FormField>
          </>
        ) : (
          <p>将按当前任务提醒商家上线。同一订单项每天只能提醒一次。</p>
        )}
        {!saved ? (
          <Checkbox
            checked={checked}
            disabled={busy}
            onChange={(event) => setChecked(event.target.checked)}
          >
            我已核对跟进对象和内容
          </Checkbox>
        ) : null}
        {error ? <Alert type="error" title={error} /> : null}
        <div className="lyx-overdue-action-buttons">
          <Button disabled={busy} onClick={close}>
            关闭
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!saved && (!checked || (kind === "follow" && !content.trim()))}
            onClick={() => void submit()}
          >
            {saved ? "重新加载结果" : kind === "follow" ? "保存跟进" : "确认提醒"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
