import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Select, Space } from "antd";
import { useState } from "react";
import type { AppServices } from "../../../app/services";
import { showSuccessNotice } from "../../../app/feedback";
import { CheckList } from "../../../components/CheckList";
import { InfoList } from "../../../components/InfoList";
import { ErrorState } from "../../../components/StateBlock";
import { DICT_QUERY } from "../../../lib/query";
import { type PatrolApi, type PatrolDetail } from "./api";
import { abnormalBody, checkedBody, PATROL_KEY } from "./model";
import { EvidenceEditor, EvidenceHistory, MutationConfirm } from "./interaction";
export const patrolLabels = {
  "mark-normal": "巡检正常",
  "mark-abnormal": "发现异常",
  recover: "复查已恢复",
  remind: "再次提醒商家",
} as const;
type Action = keyof typeof patrolLabels;
function PatrolAction({
  kind,
  detail,
  api,
  services,
  refresh,
  close,
}: {
  kind: Action;
  detail: PatrolDetail;
  api: PatrolApi;
  services: AppServices;
  refresh(): void;
  close(): void;
}) {
  const [checked, setChecked] = useState<string[]>([]),
    [evidence, setEvidence] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [reason, setReason] = useState("");
  const template = useQuery({
    queryKey: [...PATROL_KEY, "template"],
    queryFn: () => api.template("patrol.check"),
    ...DICT_QUERY,
    enabled: kind === "mark-normal" || kind === "recover",
  });
  const [seenVersion, setSeenVersion] = useState(template.data?.versionNo);
  if (seenVersion !== template.data?.versionNo) {
    setSeenVersion(template.data?.versionNo);
    setChecked([]);
  }
  const reasons = useQuery({
    queryKey: [...PATROL_KEY, "reasons"],
    queryFn: () => api.reasons("patrol_issue"),
    ...DICT_QUERY,
    enabled: kind === "mark-abnormal",
  });
  const normal = checkedBody(template.data, checked, evidence),
    abnormal = abnormalBody(reason, note, evidence);
  const valid =
    detail.actions.includes(kind) &&
    (kind === "remind"
      ? !detail.isRemindedToday
      : kind === "mark-abnormal"
        ? !!abnormal && !!reasons.data?.some((item) => item.code === reason)
        : !!normal &&
          (kind !== "recover" || evidence.every((id) => !detail.evidenceFileIds.includes(id))));
  return (
    <MutationConfirm
      title={patrolLabels[kind]}
      echo={[
        { label: "门店", value: detail.store.storeName ?? "未命名门店" },
        { label: "作品 / 账号", value: `${detail.dramaTitle} / ${detail.account.accountName}` },
      ]}
      payload={{ id: detail.patrolTaskId, kind, normal, abnormal }}
      valid={valid}
      danger={kind === "mark-abnormal"}
      refresh={refresh}
      onClose={close}
      onDone={() => showSuccessNotice(kind === "remind" ? "已登记提醒请求" : "已保存巡检结果")}
      reconcile={() => api.detail(detail.patrolTaskId)}
      send={(key, signal) =>
        kind === "remind"
          ? api.remind(detail.patrolTaskId, key, signal)
          : kind === "mark-abnormal" && abnormal
            ? api.abnormal(detail.patrolTaskId, abnormal, key, signal)
            : normal
              ? kind === "recover"
                ? api.recover(detail.patrolTaskId, normal, key, signal)
                : api.normal(detail.patrolTaskId, normal, key, signal)
              : Promise.reject(new Error("请重新核对清单与证据"))
      }
    >
      {kind === "mark-abnormal" ? (
        <>
          <label>
            异常类型
            <Select
              aria-label="异常类型"
              value={reason || undefined}
              options={reasons.data?.map((item) => ({ value: item.code, label: item.name }))}
              onChange={setReason}
            />
          </label>
          <label>
            异常说明
            <Input.TextArea
              aria-label="异常说明"
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {reasons.isError ? (
            <ErrorState message={reasons.error.message} onRetry={() => void reasons.refetch()} />
          ) : reasons.isSuccess && !reasons.data.length ? (
            <Alert type="warning" title="尚未配置启用的巡检异常类型" />
          ) : null}
        </>
      ) : null}
      {kind === "mark-normal" || kind === "recover" ? (
        template.isError ? (
          <ErrorState message={template.error.message} onRetry={() => void template.refetch()} />
        ) : template.data ? (
          <CheckList items={template.data.items} checked={checked} onChange={setChecked} />
        ) : (
          <Alert type="info" title={template.isPending ? "正在加载当前清单" : "巡检清单未配置"} />
        )
      ) : null}
      {kind !== "remind" ? (
        <EvidenceEditor
          services={services}
          storeId={detail.store.storeId}
          minimum={1}
          disabled={false}
          onChange={setEvidence}
        />
      ) : (
        <p>提醒受理后由通知通道发送，发送受理不代表商家已收到或作品已恢复。</p>
      )}
    </MutationConfirm>
  );
}
export function PatrolDetails({
  detail,
  api,
  services,
  canDo,
  refresh,
}: {
  detail: PatrolDetail;
  api: PatrolApi;
  services: AppServices;
  canDo: boolean;
  refresh(): void;
}) {
  const [action, setAction] = useState<Action>();
  const links =
    detail.liveLink?.linkKind === "collection"
      ? [{ label: "合集链接", url: detail.liveLink.collectionUrl }]
      : (detail.liveLink?.episodeUrls.map((item) => ({
          label: `第 ${item.episodeNo} 集`,
          url: item.url,
        })) ?? []);
  return (
    <div className="lyx-lifecycle-details">
      <InfoList
        items={[
          { label: "门店", value: detail.store.storeName ?? "未命名门店" },
          { label: "作品", value: `${detail.dramaTitle} · ${detail.episodeCount} 集` },
          { label: "账号", value: detail.account.accountName },
          { label: "使用期止日", value: detail.usageEndDate },
          {
            label: "巡检时间",
            value: detail.checkedAt ? date.dateTime(detail.checkedAt) : "尚未巡检",
          },
          { label: "异常类型", value: detail.abnormalKind?.name ?? "—" },
          { label: "异常说明", value: detail.note ?? "—" },
          {
            label: "恢复时间",
            value: detail.recoveredAt ? date.dateTime(detail.recoveredAt) : "—",
          },
          {
            label: "跟进截止",
            value: detail.followUpDueAt ? date.dateTime(detail.followUpDueAt) : "—",
          },
          {
            label: "已提醒",
            value: `${detail.remindCount} 次${detail.isRemindedToday ? " · 今日已提醒" : ""}`,
          },
        ]}
      />
      {links.map((link) => (
        <p key={link.label}>
          {link.label}：
          {link.url && /^https:\/\//i.test(link.url) ? (
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              打开上线作品
            </a>
          ) : (
            "链接不可打开"
          )}
        </p>
      ))}
      {detail.results.length ? (
        <section>
          <h3 className="lyx-section-title">已记录清单</h3>
          {detail.results.map((item) => (
            <p key={item.key}>
              {item.label}：
              {item.result === "pass"
                ? "通过"
                : item.result === "fail"
                  ? "未通过"
                  : (item.result ?? "未记录")}
            </p>
          ))}
        </section>
      ) : null}
      <EvidenceHistory key={detail.patrolTaskId} ids={detail.evidenceFileIds} api={api} />
      <section>
        <h3 className="lyx-section-title">近期巡检</h3>
        {detail.history.length ? (
          <ul className="lyx-lifecycle-history">
            {detail.history.map((item) => (
              <li key={item.patrolTaskId}>
                {item.weekStartDate} ·{" "}
                {item.status === "recovered"
                  ? "已恢复"
                  : item.status === "normal"
                    ? "正常"
                    : item.status === "abnormal"
                      ? "异常"
                      : "待巡检"}
                {item.abnormalKind ? ` · ${item.abnormalKind.name}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无历史巡检</p>
        )}
      </section>
      {canDo ? (
        <Space wrap>
          {detail.actions.map((kind) => (
            <Button
              key={kind}
              disabled={kind === "remind" && detail.isRemindedToday}
              type={kind === "mark-normal" || kind === "recover" ? "primary" : "default"}
              danger={kind === "mark-abnormal"}
              onClick={() => setAction(kind)}
            >
              {patrolLabels[kind]}
            </Button>
          ))}
        </Space>
      ) : (
        <p>当前权限仅可查看巡检记录</p>
      )}
      {action && canDo ? (
        <PatrolAction
          key={`${detail.patrolTaskId}:${action}`}
          kind={action}
          detail={detail}
          api={api}
          services={services}
          refresh={refresh}
          close={() => setAction(undefined)}
        />
      ) : null}
    </div>
  );
}
