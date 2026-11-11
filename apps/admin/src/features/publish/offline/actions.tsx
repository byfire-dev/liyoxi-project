import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Select } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { AppServices } from "../../../app/services";
import { showSuccessNotice } from "../../../app/feedback";
import { CheckList } from "../../../components/CheckList";
import { ErrorState } from "../../../components/StateBlock";
import { DETAIL_QUERY, DICT_QUERY } from "../../../lib/query";
import { EvidenceEditor, MutationConfirm } from "../patrol/interaction";
import type { CheckBody, OfflineApi, OfflineDetail, OfflineRow } from "./api";
import {
  actionLabels,
  batchBody,
  batchRejections,
  checkBody,
  OFFLINE_KEY,
  type OfflineAction,
} from "./model";

function CheckForm({
  detail,
  api,
  services,
  onChange,
}: {
  detail: OfflineDetail;
  api: OfflineApi;
  services: AppServices;
  onChange(body: CheckBody | null): void;
}) {
  const [checked, setChecked] = useState<string[]>([]),
    [evidence, setEvidence] = useState<string[]>([]);
  const template = useQuery({
    queryKey: [...OFFLINE_KEY, "template", detail.expectedChecklistCode],
    queryFn: () => api.template(detail.expectedChecklistCode),
    ...DICT_QUERY,
  });
  const [seenVersion, setSeenVersion] = useState(template.data?.versionNo);
  if (seenVersion !== template.data?.versionNo) {
    setSeenVersion(template.data?.versionNo);
    setChecked([]);
  }
  useEffect(() => {
    onChange(checkBody(detail, template.data, checked, evidence));
  }, [detail, template.data, checked, evidence, onChange]);
  return (
    <section className="lyx-lifecycle-details">
      <h3 className="lyx-section-title">
        {detail.dramaTitle} · {detail.account.accountName}
      </h3>
      <p>
        {detail.expectedChecklistCode === "takedown.absence_check"
          ? "核对未核验上线内容的缺席情况"
          : "核对已上线内容的下架情况"}
      </p>
      {template.isError ? (
        <ErrorState message={template.error.message} onRetry={() => void template.refetch()} />
      ) : template.data ? (
        <CheckList items={template.data.items} checked={checked} onChange={setChecked} />
      ) : (
        <Alert
          type="info"
          title={template.isPending ? "正在加载当前核查清单" : "当前核查清单未配置"}
        />
      )}
      <EvidenceEditor
        services={services}
        storeId={detail.store.storeId}
        minimum={2}
        disabled={false}
        onChange={setEvidence}
      />
    </section>
  );
}
export function OfflineActionModal({
  kind,
  detail,
  api,
  services,
  refresh,
  close,
}: {
  kind: OfflineAction;
  detail: OfflineDetail;
  api: OfflineApi;
  services: AppServices;
  refresh(): void;
  close(): void;
}) {
  const [body, setBody] = useState<CheckBody | null>(null),
    [note, setNote] = useState("");
  const valid =
    detail.actions.includes(kind) &&
    (kind === "check"
      ? !!body
      : kind === "send-breach-notice"
        ? !detail.isBreachNoticedToday
        : note.length <= 200);
  return (
    <MutationConfirm
      title={actionLabels[kind]}
      echo={[
        { label: "作品 / 账号", value: `${detail.dramaTitle} / ${detail.account.accountName}` },
        { label: "下架截止", value: detail.dueDate },
      ]}
      payload={{ id: detail.takedownTaskId, kind, body, note }}
      valid={valid}
      danger={kind === "mark-online"}
      refresh={refresh}
      onClose={close}
      onDone={() =>
        showSuccessNotice(kind === "send-breach-notice" ? "已登记违约提醒请求" : "已保存处理记录")
      }
      reconcile={() => api.detail(detail.takedownTaskId)}
      send={(key, signal) =>
        kind === "check" && body
          ? api.check(detail.takedownTaskId, body, key, signal)
          : kind === "mark-online"
            ? api.online(
                detail.takedownTaskId,
                note.trim() ? { note: note.trim() } : {},
                key,
                signal,
              )
            : kind === "escalate"
              ? api.escalate(
                  detail.takedownTaskId,
                  note.trim() ? { note: note.trim() } : {},
                  key,
                  signal,
                )
              : kind === "send-breach-notice"
                ? api.breach(detail.takedownTaskId, key, signal)
                : Promise.reject(new Error("清单未完成"))
      }
    >
      {kind === "check" ? (
        <CheckForm detail={detail} api={api} services={services} onChange={setBody} />
      ) : kind === "send-breach-notice" ? (
        <p>本操作登记提醒请求。通知受理不代表送达，也不代表平台作品已下架。</p>
      ) : (
        <>
          <p>
            {kind === "mark-online"
              ? "记录仍在线事实，商家将需要重新处理下架任务。"
              : "记录逾期升级并通知负责人员，不会替代实际下架核查。"}
          </p>
          <label>
            处理说明（选填）
            <Input.TextArea
              aria-label="处理说明"
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </>
      )}
    </MutationConfirm>
  );
}
function BatchItem({
  id,
  api,
  services,
  onChange,
}: {
  id: string;
  api: OfflineApi;
  services: AppServices;
  onChange(id: string, body: CheckBody | null): void;
}) {
  const detail = useQuery({
    queryKey: [...OFFLINE_KEY, "batch-detail", id],
    queryFn: ({ signal }) => api.detail(id, signal),
    ...DETAIL_QUERY,
  });
  const update = useCallback((body: CheckBody | null) => onChange(id, body), [id, onChange]);
  useEffect(() => {
    if (!detail.data || detail.isError) update(null);
  }, [detail.data, detail.isError, update]);
  return detail.isError ? (
    <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
  ) : detail.data ? (
    <CheckForm
      key={`${id}:${detail.data.status}:${detail.data.expectedChecklistCode}`}
      detail={detail.data}
      api={api}
      services={services}
      onChange={update}
    />
  ) : (
    <p>正在读取核查对象…</p>
  );
}
export function OfflineBatchModal({
  rows,
  api,
  services,
  refresh,
  close,
}: {
  rows: readonly OfflineRow[];
  api: OfflineApi;
  services: AppServices;
  refresh(): void;
  close(): void;
}) {
  const [ids, setIds] = useState<string[]>([]),
    [entries, setEntries] = useState<Record<string, CheckBody | null>>({}),
    [failures, setFailures] = useState<ReturnType<typeof batchRejections>>([]);
  const update = useCallback(
    (id: string, body: CheckBody | null) => setEntries((old) => ({ ...old, [id]: body })),
    [],
  );
  const body = batchBody(ids, entries);
  return (
    <MutationConfirm
      title="批量核查下架"
      echo={[{ label: "本次任务", value: `${ids.length} 项（最多 50 项）` }]}
      payload={body}
      valid={!!body}
      refresh={refresh}
      onClose={close}
      onDone={() => showSuccessNotice("已完成本批核查，请以工单实际状态确认归档结果")}
      reconcile={() => Promise.all(ids.map((id) => api.detail(id)))}
      send={async (key, signal) => {
        if (!body) throw new Error("请逐项核对并上传证据");
        setFailures([]);
        try {
          return await api.batch(body, key, signal);
        } catch (cause) {
          if (!signal.aborted) setFailures(batchRejections(cause));
          throw cause;
        }
      }}
    >
      <Alert type="info" title="本批一起提交；任意一项不符合条件，整批均不处理" />
      <label>
        选择本批核查任务
        <Select
          mode="multiple"
          aria-label="选择本批核查任务"
          value={ids}
          maxCount={50}
          options={rows
            .filter((row) => row.actions.includes("check"))
            .map((row) => ({
              value: row.takedownTaskId,
              label: `${row.dramaTitle} · ${row.account.accountName}`,
            }))}
          onChange={(next) => {
            setIds(next);
            setFailures([]);
          }}
        />
      </label>
      {failures.length ? (
        <section aria-label="批量拒绝原因">
          <Alert type="error" title="本批未处理，请逐项纠正后重新确认" />
          {failures.map((item) => (
            <p key={item.takedownTaskId}>
              第 {item.index + 1} 项 ·{" "}
              {rows.find((row) => row.takedownTaskId === item.takedownTaskId)?.account
                .accountName ?? item.takedownTaskId}
              ：{item.message}
            </p>
          ))}
          <Button
            onClick={() => {
              void services.queryClient.invalidateQueries({
                queryKey: [...OFFLINE_KEY, "batch-detail"],
              });
              void services.queryClient.invalidateQueries({
                queryKey: [...OFFLINE_KEY, "template"],
              });
            }}
          >
            重新读取对象与清单
          </Button>
        </section>
      ) : null}
      {ids.map((id) => (
        <BatchItem key={id} id={id} api={api} services={services} onChange={update} />
      ))}
    </MutationConfirm>
  );
}
