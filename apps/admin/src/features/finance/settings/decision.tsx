import { Alert, Button, Checkbox, Input, Modal, Space } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AccessContext } from "../../../lib/permissions";
import { configConflict, configError, type ConfigApi } from "./api";
import { actionLabels, configDecisions, configLabels, createConfigIntent } from "./model";
import { ConfigPayload } from "./payload";
import type { ConfigDecision, ConfigRevision } from "./types";

export function ConfigDecisionPanel({
  value,
  current,
  api,
  refresh,
  changed,
}: {
  value: ConfigRevision;
  current: ConfigRevision | null;
  api: ConfigApi;
  refresh: (signal: AbortSignal) => Promise<unknown>;
  changed: () => void;
}) {
  const access = useContext(AccessContext),
    intent = useMemo(() => createConfigIntent(), []),
    alive = useRef(true),
    reader = useRef<AbortController | undefined>(undefined),
    [action, setAction] = useState<ConfigDecision>(),
    [note, setNote] = useState(""),
    [last4, setLast4] = useState(""),
    [checked, setChecked] = useState<string>(),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [notice, setNotice] = useState<string>();
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      reader.current?.abort();
    };
  }, [intent]);
  const actions = configDecisions(value, access),
    stamp = JSON.stringify([value, current, action, note.trim(), last4]),
    ready =
      !!action &&
      actions.includes(action) &&
      !stale &&
      checked === stamp &&
      (action !== "reject" || !!note.trim()) &&
      (action !== "approve" || value.configKey !== "bank_account" || /^\d{4}$/.test(last4));
  const close = () => {
    if (!busy && !intent.pending && !reader.current) setAction(undefined);
  };
  async function reload(signal: AbortSignal) {
    await refresh(signal);
    signal.throwIfAborted();
    if (alive.current) {
      setStale(false);
      setChecked(undefined);
    }
  }
  async function submit() {
    if (!action || !ready || busy || intent.pending) return;
    const selected = action;
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = await intent.submit(
        selected,
        [value.financeConfigRevisionId, value.approval.lockVersion, selected, note.trim(), last4],
        async (key, signal) => {
          try {
            await api.decide(value, selected, note.trim(), last4, key, signal);
          } catch (error) {
            if (configConflict(error) && alive.current && !signal.aborted) {
              setStale(true);
              setChecked(undefined);
              try {
                await reload(signal);
              } catch {
                /* 读取失败保持停写。 */
              }
            }
            throw error;
          }
          if (!alive.current || signal.aborted) return false;
          setStale(true);
          changed();
          try {
            await reload(signal);
          } catch {
            if (alive.current && !signal.aborted)
              setNotice("操作已提交成功，详情读取失败，请重新读取，不要重复提交");
          }
          return true;
        },
      );
      if (outcome && alive.current) {
        setAction(undefined);
        setChecked(undefined);
      }
    } catch (error) {
      if (alive.current) setNotice(configError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function reread() {
    if (busy || intent.pending || reader.current) return;
    const controller = new AbortController();
    reader.current = controller;
    setBusy(true);
    try {
      await reload(controller.signal);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(configError(error));
    } finally {
      if (reader.current === controller) reader.current = undefined;
      if (alive.current) setBusy(false);
    }
  }
  const reloadButton = (
    <Button disabled={busy} onClick={() => void reread()}>
      重新读取当前配置
    </Button>
  );
  return (
    <>
      {notice && !action ? <Alert type="warning" title={notice} /> : null}
      {stale ? (
        <Alert
          type="warning"
          title="当前配置已失效，重新读取并核对后才可处理"
          action={reloadButton}
        />
      ) : null}
      <Space wrap>
        {actions.map((next) => (
          <Button
            key={next}
            type={next === "approve" ? "primary" : "default"}
            danger={next === "reject"}
            disabled={busy || stale}
            onClick={() => {
              setAction(next);
              setChecked(undefined);
              setNote("");
              setLast4("");
              setNotice(undefined);
            }}
          >
            {actionLabels[next]}
          </Button>
        ))}
      </Space>
      <Modal
        open={!!action}
        title={`${action ? actionLabels[action] : "处理"}${configLabels[value.configKey]}`}
        footer={null}
        width={720}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        onCancel={close}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          {notice ? <Alert type="warning" title={notice} /> : null}
          <h3>当前生效值</h3>
          <ConfigPayload value={current} />
          <h3>待处理提议</h3>
          <ConfigPayload value={value} />
          <p>变更说明：{value.changeNote}</p>
          <p>审批版本：{value.approval.lockVersion}</p>
          {action === "approve" && value.configKey === "bank_account" ? (
            <>
              <Alert type="info" title="批准24小时后生效，等待期内沿用原收款账户。" />
              <label>
                核对新账户尾四位
                <Input
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="off"
                  value={last4}
                  disabled={busy || stale}
                  onChange={(e) => setLast4(e.target.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            {action === "reject" ? "驳回说明（必填）" : "处理说明（可选）"}
            <Input.TextArea
              maxLength={200}
              showCount
              value={note}
              disabled={busy || stale}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Checkbox
            disabled={busy || stale}
            checked={checked === stamp}
            onChange={(e) => setChecked(e.target.checked ? stamp : undefined)}
          >
            我已核对配置差异、变更说明和生效规则
          </Checkbox>
          {stale ? reloadButton : null}
          <Space>
            <Button disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="primary"
              danger={action === "reject"}
              loading={busy}
              disabled={!ready || busy}
              onClick={() => void submit()}
            >
              确认{action ? actionLabels[action] : "处理"}
            </Button>
          </Space>
        </Space>
      </Modal>
    </>
  );
}
