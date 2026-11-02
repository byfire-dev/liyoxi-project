import { LicenseLetterCorrectBodySchema, LicenseLetterVoidBodySchema } from "@liyoxi/contract";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, Modal, Select, Spin } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { useCan } from "../../../lib/permissions";
import {
  aftercareError,
  definiteAftercareRejection,
  type LicenseCommand,
  type LicenseLetter,
  type LicenseList,
  type OrderAftercareApi,
} from "./aftercare-api";
import { createOrderIntent } from "./aftercare-intent";

const actions = {
  correct: "更正授权书",
  void: "作废并按当前事实重出",
  rerender: "重新生成失败版次",
} as const;
const kinds = {
  licensee_name: "主体名称",
  store_name: "门店名称",
  account_name: "账号名称",
  other: "其他",
} as const;
const states: Readonly<Record<string, string>> = {
  pending_effective: "待生效",
  effective: "已生效",
  voided: "已作废",
  queued: "等待生成",
  rendering: "生成中",
  ready: "PDF已就绪",
  failed: "生成失败",
};
const revisionReasons: Readonly<Record<string, string>> = {
  initial: "首次签发",
  go_live: "上线生效",
  period_changed: "使用期变更",
  correction: "资料更正",
  resign: "重新签署",
};
const voidReasons: Readonly<Record<string, string>> = {
  cancelled: "业务取消",
  terminated: "使用终止",
  account_removed: "账号移除",
  manual: "人工作废",
};
export function licenseIdentity(letter: LicenseLetter | undefined) {
  return JSON.stringify(
    letter && [
      letter.licenseLetterId,
      letter.status,
      letter.currentRevision?.licenseLetterRevisionId,
      letter.currentRevision?.renderStatus,
      letter.currentRevision?.contentFp,
      letter.actions,
      letter.revisions.map((revision) => [
        revision.licenseLetterRevisionId,
        revision.renderStatus,
        revision.renderAttemptNo,
        revision.contentFp,
        revision.actions,
      ]),
    ],
  );
}
export function latestLicenseRevision(letter: LicenseLetter) {
  return letter.revisions.reduce<LicenseLetter["revisions"][number] | undefined>(
    (latest, revision) => (!latest || revision.revNo > latest.revNo ? revision : latest),
    undefined,
  );
}
export function canRerenderRevision(letter: LicenseLetter, revisionId: string) {
  const revision = letter.revisions.find((row) => row.licenseLetterRevisionId === revisionId);
  return (
    letter.status !== "voided" &&
    revision?.renderStatus === "failed" &&
    revision.actions.includes("rerender")
  );
}
export function currentPdfReady(letter: LicenseLetter) {
  return (
    letter.status !== "voided" &&
    letter.currentRevision?.renderStatus === "ready" &&
    !!letter.currentRevision.fileId &&
    !!letter.currentRevision.readyAt
  );
}
function LicenseMutation({
  api,
  orderId,
  itemId,
  letter,
  kind,
  targetRevisionId,
  onClose,
  onChanged,
}: {
  api: OrderAftercareApi;
  orderId: string;
  itemId: string;
  letter: LicenseLetter;
  kind: LicenseCommand["kind"];
  targetRevisionId?: string;
  onClose(): void;
  onChanged(data: LicenseList): void;
}) {
  const [note, setNote] = useState(""),
    [corrections, setCorrections] = useState<Array<keyof typeof kinds>>([]),
    [checked, setChecked] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const workspace = useMemo(
    () =>
      createOrderIntent(
        (signal) => api.licenses(orderId, itemId, signal),
        undefined,
        definiteAftercareRejection,
      ),
    [api, orderId, itemId],
  );
  useEffect(() => {
    workspace.activate();
    return () => workspace.close();
  }, [workspace]);
  const revisionId =
    kind === "rerender"
      ? (targetRevisionId ?? null)
      : (letter.currentRevision?.licenseLetterRevisionId ?? null);
  const targetRevision = letter.revisions.find((row) => row.licenseLetterRevisionId === revisionId);
  const correct = LicenseLetterCorrectBodySchema.safeParse({ note, correctionKinds: corrections });
  const voided = LicenseLetterVoidBodySchema.safeParse({ note });
  const command: LicenseCommand | null =
    kind === "correct"
      ? correct.success
        ? { kind, letterId: letter.licenseLetterId, revisionId, body: correct.data }
        : null
      : kind === "void"
        ? voided.success
          ? { kind, letterId: letter.licenseLetterId, revisionId, body: voided.data }
          : null
        : revisionId && canRerenderRevision(letter, revisionId)
          ? { kind, letterId: letter.licenseLetterId, revisionId, body: {} }
          : null;
  const identity = command ? JSON.stringify({ command, facts: licenseIdentity(letter) }) : "";
  const locked = workspace.locked(),
    accepted = workspace.accepted();
  const sameIntent = !locked || identity === workspace.identity();
  const submit = async () => {
    if (!command || checked !== identity || accepted || !sameIntent) return;
    setBusy(true);
    setError(undefined);
    try {
      const current = await workspace.submit(
        identity,
        (fresh) =>
          licenseIdentity(
            fresh.items.find((row) => row.licenseLetterId === letter.licenseLetterId),
          ) === licenseIdentity(letter),
        (_fresh, key, signal) => api.writeLicense(orderId, itemId, command, key, signal),
      );
      if (current) {
        onChanged(current);
        onClose();
      }
    } catch (cause) {
      if (workspace.active()) {
        setError(
          workspace.accepted()
            ? "操作已受理，读取当前版次失败；原意图重试只刷新结果"
            : aftercareError(cause),
        );
        setChecked(undefined);
      }
    } finally {
      if (workspace.active()) setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const current = await workspace.refresh();
      if (!current) return;
      onChanged(current);
      const fresh = current.items.find((row) => row.licenseLetterId === letter.licenseLetterId);
      if (workspace.accepted() || !sameIntent || licenseIdentity(fresh) !== licenseIdentity(letter))
        onClose();
      else {
        setChecked(undefined);
        setError("当前事实已刷新；原操作结果未确认，请用原正文和原意图重试");
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
      title={actions[kind]}
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
        <p>
          {letter.letterNo} · {letter.accountName} ·{" "}
          {kind === "rerender" ? "重生目标第" : "当前可用第"} {targetRevision?.revNo ?? "—"} 版
        </p>
        <Alert
          type="info"
          title={
            kind === "rerender"
              ? "重新生成仅受理渲染任务，完成后需刷新核对真实PDF"
              : "只按当前业务资料重出，不在本页修改授权法律正文"
          }
        />
        {kind === "correct" ? (
          <FormField label="更正类型">
            {(props) => (
              <Select
                {...props}
                mode="multiple"
                value={corrections}
                disabled={busy || locked}
                onChange={setCorrections}
                options={Object.entries(kinds).map(([value, label]) => ({ value, label }))}
              />
            )}
          </FormField>
        ) : null}
        {kind !== "rerender" ? (
          <FormField label="处理原因" value={note} maxLength={200}>
            {(props) => (
              <Input.TextArea
                {...props}
                rows={3}
                value={note}
                maxLength={200}
                disabled={busy || locked}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </FormField>
        ) : null}
        <Checkbox
          checked={!!identity && checked === identity}
          disabled={busy || accepted || !sameIntent || !command}
          onChange={(event) => setChecked(event.target.checked ? identity : undefined)}
        >
          我已核对授权编号、账号和操作版次；受理不代表PDF已生成
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
          <Button
            type="primary"
            danger={kind === "void"}
            disabled={!command || checked !== identity || accepted || !sameIntent}
            loading={busy}
            onClick={() => void submit()}
          >
            {actions[kind]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function OrderLicenses({
  api,
  orderId,
  itemId,
  title,
  scope,
  onChanged,
}: {
  api: OrderAftercareApi;
  orderId: string;
  itemId: string;
  title: string;
  scope: string;
  onChanged(): void;
}) {
  const allowed = useCan("order.license_letter.manage");
  const query = useQuery({
    queryKey: ["order-licenses", scope, orderId, itemId],
    queryFn: ({ signal }) => api.licenses(orderId, itemId, signal),
    retry: false,
  });
  const [mutation, setMutation] = useState<{
      letter: LicenseLetter;
      kind: LicenseCommand["kind"];
      revisionId?: string;
    }>(),
    [error, setError] = useState<string>();
  const currentMutation = query.data?.items.find(
    (row) => row.licenseLetterId === mutation?.letter.licenseLetterId,
  );
  const owner = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    return () => {
      controller.abort();
      if (owner.current === controller) owner.current = undefined;
    };
  }, []);
  const download = async (letter: LicenseLetter) => {
    const controller = owner.current;
    if (!controller || controller.signal.aborted) return;
    setError(undefined);
    try {
      const url = await api.pdf(orderId, itemId, letter.licenseLetterId, controller.signal);
      if (!controller.signal.aborted) window.open(url, "_blank", "noopener,noreferrer");
    } catch (cause) {
      if (!controller.signal.aborted) setError(aftercareError(cause));
    }
  };
  return (
    <section className="lyx-order-item" aria-label={`${title}授权书`}>
      <div className="lyx-order-item__title">
        <h3>{title} · 授权书</h3>
        <Button onClick={() => void query.refetch()}>刷新授权状态</Button>
      </div>
      {query.isPending ? (
        <Spin />
      ) : query.isError ? (
        <Alert type="error" title={aftercareError(query.error)} />
      ) : !query.data.items.length ? (
        <p>暂无授权书</p>
      ) : (
        query.data.items.map((letter) => {
          const latest = latestLicenseRevision(letter);
          const different =
            latest &&
            latest.licenseLetterRevisionId !== letter.currentRevision?.licenseLetterRevisionId;
          return (
            <article key={letter.licenseLetterId} className="lyx-order-letter">
              <strong>
                {letter.letterNo} · {letter.accountName}
              </strong>
              <p>
                {states[letter.status] ?? "其他授权状态"}
                {letter.isExpired ? " · 使用期已结束" : ""} ·{" "}
                {letter.periodStart ? date.date(letter.periodStart) : "上线首日"} 至{" "}
                {date.date(letter.periodEnd)}
              </p>
              <p>
                当前可用PDF：
                {letter.currentRevision
                  ? `第${letter.currentRevision.revNo}版 · ${states[letter.currentRevision.renderStatus] ?? "其他生成状态"} · 已尝试${letter.currentRevision.renderAttemptNo}次`
                  : "尚无可用版次"}
              </p>
              <p>
                最新生成版次：
                {latest
                  ? `第${latest.revNo}版 · ${states[latest.renderStatus] ?? "其他生成状态"} · 已尝试${latest.renderAttemptNo}次`
                  : "尚无版次"}
              </p>
              {different && letter.currentRevision ? (
                <Alert
                  type={latest.renderStatus === "failed" ? "warning" : "info"}
                  title={`${latest.renderStatus === "failed" ? "最新生成失败" : "新版处理中"}，当前可用PDF仍为第${letter.currentRevision.revNo}版`}
                />
              ) : null}
              {latest?.renderIssue ? (
                <Alert
                  type="warning"
                  title="最新生成版次存在缺字，请先核对上游资料再重新生成"
                  description={latest.renderIssue.missing
                    .map((row) => `${row.character}（${row.codePoint}）`)
                    .join("、")}
                />
              ) : null}
              <div className="lyx-order-form__actions">
                <Button disabled={!currentPdfReady(letter)} onClick={() => void download(letter)}>
                  下载当前授权PDF
                </Button>
                {allowed
                  ? letter.actions.map((kind) => (
                      <Button key={kind} onClick={() => setMutation({ letter, kind })}>
                        {actions[kind]}
                      </Button>
                    ))
                  : null}
                {allowed &&
                latest &&
                canRerenderRevision(letter, latest.licenseLetterRevisionId) ? (
                  <Button
                    onClick={() =>
                      setMutation({
                        letter,
                        kind: "rerender",
                        revisionId: latest.licenseLetterRevisionId,
                      })
                    }
                  >
                    {actions.rerender}
                  </Button>
                ) : null}
              </div>
              <details>
                <summary>授权版次历史（{letter.revisions.length}）</summary>
                {letter.revisions.map((revision) => (
                  <div key={revision.licenseLetterRevisionId}>
                    <p>
                      第{revision.revNo}版 · {states[revision.renderStatus] ?? "其他生成状态"} ·{" "}
                      {date.dateTime(revision.createdAt)} ·{" "}
                      {revisionReasons[revision.reason] ?? "其他版次原因"}
                      {revision.readyAt ? ` · ${date.dateTime(revision.readyAt)} 就绪` : ""}
                    </p>
                    {allowed && canRerenderRevision(letter, revision.licenseLetterRevisionId) ? (
                      <Button
                        onClick={() =>
                          setMutation({
                            letter,
                            kind: "rerender",
                            revisionId: revision.licenseLetterRevisionId,
                          })
                        }
                      >
                        重新生成第{revision.revNo}版
                      </Button>
                    ) : null}
                  </div>
                ))}
                {letter.voidedAt ? (
                  <p>
                    {date.dateTime(letter.voidedAt)} 作废 ·{" "}
                    {letter.voidReason ? (voidReasons[letter.voidReason] ?? "其他作废原因") : "—"}
                  </p>
                ) : null}
              </details>
            </article>
          );
        })
      )}
      {error ? <Alert type="error" title={error} /> : null}
      {mutation && currentMutation && allowed ? (
        <LicenseMutation
          key={`${currentMutation.licenseLetterId}:${mutation.kind}`}
          api={api}
          orderId={orderId}
          itemId={itemId}
          kind={mutation.kind}
          targetRevisionId={mutation.revisionId}
          letter={currentMutation}
          onClose={() => setMutation(undefined)}
          onChanged={() => {
            void query.refetch();
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
