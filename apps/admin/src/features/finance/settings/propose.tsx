import { FinanceConfigCreateBodySchema, type FinanceConfigCreateBody } from "@liyoxi/contract";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { configConflict, configError, type ConfigApi } from "./api";
import { configKeys, configLabels, createConfigIntent, currentConfig } from "./model";
import { ConfigPayload } from "./payload";
import { PolicyForm } from "./policy-form";
import type { ConfigKey, ConfigRevision } from "./types";

function initial(key: ConfigKey, items: readonly ConfigRevision[]): FinanceConfigCreateBody {
  const current = currentConfig(items, key),
    payload = current?.payload;
  const common = {
    changeNote: "",
    confirm: { configKey: key, baseRevisionId: current?.financeConfigRevisionId ?? null },
  };
  if (key === "bank_account")
    return {
      ...common,
      configKey: key,
      payload: {
        accountName: payload && "accountName" in payload ? payload.accountName : "",
        bankName: payload && "bankName" in payload ? payload.bankName : "",
        accountNo: "",
      },
    };
  if (key === "purchase_policy")
    return {
      ...common,
      configKey: key,
      payload: payload && "rules" in payload ? structuredClone(payload) : { rules: [] },
    };
  return {
    ...common,
    configKey: key,
    payload:
      payload && "adminCreateOrder" in payload
        ? structuredClone(payload)
        : {
            adminCreateOrder: false,
            shippingReport: false,
            wechatSingleLimitFen: 0,
            wechatDailyLimitFen: 0,
            receiptSecondReviewFen: null,
          },
  };
}
export function ProposeConfig({
  items,
  api,
  refreshCurrent,
  onCreated,
  onClose,
}: {
  items: readonly ConfigRevision[];
  api: ConfigApi;
  refreshCurrent: (signal: AbortSignal) => Promise<unknown>;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<FinanceConfigCreateBody>(() => initial("bank_account", items)),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [notice, setNotice] = useState<string>(),
    [checked, setChecked] = useState<string>(),
    [committed, setCommitted] = useState<string>(),
    intent = useMemo(() => createConfigIntent(), []),
    alive = useRef(true),
    reading = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      reading.current?.abort();
    };
  }, [intent]);
  const current = currentConfig(items, draft.configKey),
    body = {
      ...draft,
      confirm: {
        configKey: draft.configKey,
        baseRevisionId: current?.financeConfigRevisionId ?? null,
      },
    },
    stamp = JSON.stringify(body),
    disabled = busy || !!committed || blocked;
  async function readCreated(id: string, signal: AbortSignal) {
    const row = await api.get(id, signal);
    signal.throwIfAborted();
    if (alive.current) onCreated(row.financeConfigRevisionId);
  }
  async function submit() {
    if (busy || blocked || intent.pending || committed || checked !== stamp) return;
    const candidate =
      body.configKey === "purchase_policy"
        ? {
            ...body,
            payload: {
              rules: body.payload.rules.map((rule) => ({
                ...rule,
                when: {
                  ...rule.when,
                  versionRange: rule.when.versionRange?.trim() || undefined,
                  entityIds: rule.when.entityIds?.map((id) => id.trim()).filter(Boolean).length
                    ? rule.when.entityIds.map((id) => id.trim()).filter(Boolean)
                    : undefined,
                },
              })),
            },
          }
        : body;
    const parsed = FinanceConfigCreateBodySchema.safeParse(candidate);
    if (!parsed.success) {
      setNotice("请核对必填内容、整数金额、主体编号与变更说明");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await intent.submit("create", parsed.data, async (key, signal) => {
        const row = await api.create(parsed.data, key, signal);
        if (!alive.current || signal.aborted) return;
        setCommitted(row.financeConfigRevisionId);
        try {
          await readCreated(row.financeConfigRevisionId, signal);
        } catch {
          if (alive.current && !signal.aborted)
            setNotice("提议已提交成功，详情读取失败，请重新读取，不要重复提交");
        }
      });
    } catch (error) {
      if (alive.current) {
        setNotice(configError(error));
        if (configConflict(error)) {
          setChecked(undefined);
          setBlocked(true);
          const controller = new AbortController();
          reading.current = controller;
          try {
            await refreshCurrent(controller.signal);
            if (alive.current && !controller.signal.aborted) setBlocked(false);
          } catch {
            if (alive.current) setNotice("配置基准读取失败，请关闭弹层并重新读取后再提交");
          } finally {
            if (reading.current === controller) reading.current = undefined;
          }
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function reread() {
    if (!committed || busy || reading.current) return;
    const controller = new AbortController();
    reading.current = controller;
    setBusy(true);
    try {
      await readCreated(committed, controller.signal);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(configError(error));
    } finally {
      if (reading.current === controller) reading.current = undefined;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="提议财务配置变更"
      width={760}
      styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      footer={null}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      onCancel={onClose}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        {notice ? <Alert type="warning" title={notice} /> : null}
        <label>
          配置项目
          <Select
            aria-label="配置项目"
            style={{ width: "100%" }}
            disabled={disabled}
            value={draft.configKey}
            options={configKeys.map((value) => ({ value, label: configLabels[value] }))}
            onChange={(key) => {
              setDraft(initial(key, items));
              setChecked(undefined);
              setNotice(undefined);
            }}
          />
        </label>
        <h3>当前生效值</h3>
        <ConfigPayload value={current} />
        <h3>提议值</h3>
        {draft.configKey === "bank_account" ? (
          <>
            <Alert
              type="info"
              title="收款账户须由另一人审批，批准24小时后生效；账号仅在本次输入中使用。"
            />
            <label>
              户名
              <Input
                disabled={disabled}
                maxLength={200}
                value={draft.payload.accountName}
                onChange={(e) =>
                  setDraft({ ...draft, payload: { ...draft.payload, accountName: e.target.value } })
                }
              />
            </label>
            <label>
              开户行
              <Input
                disabled={disabled}
                maxLength={200}
                value={draft.payload.bankName}
                onChange={(e) =>
                  setDraft({ ...draft, payload: { ...draft.payload, bankName: e.target.value } })
                }
              />
            </label>
            <label>
              完整银行账号
              <Input.Password
                disabled={disabled}
                autoComplete="off"
                maxLength={64}
                value={draft.payload.accountNo}
                onChange={(e) =>
                  setDraft({ ...draft, payload: { ...draft.payload, accountNo: e.target.value } })
                }
              />
            </label>
          </>
        ) : draft.configKey === "purchase_policy" ? (
          <PolicyForm
            value={draft.payload}
            disabled={disabled}
            onChange={(payload) => setDraft({ ...draft, payload })}
          />
        ) : (
          <>
            <Checkbox
              disabled={disabled}
              checked={draft.payload.adminCreateOrder}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  payload: { ...draft.payload, adminCreateOrder: e.target.checked },
                })
              }
            >
              允许后台代开单
            </Checkbox>
            <label>
              微信单笔限额（分）
              <InputNumber
                min={0}
                precision={0}
                disabled={disabled}
                value={draft.payload.wechatSingleLimitFen}
                onChange={(n) =>
                  setDraft({
                    ...draft,
                    payload: { ...draft.payload, wechatSingleLimitFen: n ?? 0 },
                  })
                }
              />
            </label>
            <label>
              微信每日限额（分）
              <InputNumber
                min={0}
                precision={0}
                disabled={disabled}
                value={draft.payload.wechatDailyLimitFen}
                onChange={(n) =>
                  setDraft({ ...draft, payload: { ...draft.payload, wechatDailyLimitFen: n ?? 0 } })
                }
              />
            </label>
            <label>
              收款二次复核阈值（分；留空为不启用）
              <InputNumber
                min={1}
                precision={0}
                disabled={disabled}
                value={draft.payload.receiptSecondReviewFen}
                onChange={(n) =>
                  setDraft({ ...draft, payload: { ...draft.payload, receiptSecondReviewFen: n } })
                }
              />
            </label>
            <Checkbox
              disabled={disabled}
              checked={draft.payload.shippingReport}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  payload: { ...draft.payload, shippingReport: e.target.checked },
                })
              }
            >
              开启微信发货上报
            </Checkbox>
          </>
        )}
        <label>
          变更说明
          <Input.TextArea
            aria-label="变更说明"
            disabled={disabled}
            maxLength={200}
            showCount
            value={draft.changeNote}
            onChange={(e) => setDraft({ ...draft, changeNote: e.target.value })}
          />
        </label>
        <Checkbox
          disabled={disabled}
          checked={checked === stamp}
          onChange={(e) => setChecked(e.target.checked ? stamp : undefined)}
        >
          我已核对当前值、提议值及变更影响
        </Checkbox>
        <Space>
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {committed ? (
            <Button loading={busy} onClick={() => void reread()}>
              重新读取已提交提议
            </Button>
          ) : (
            <Button
              type="primary"
              loading={busy}
              disabled={disabled || checked !== stamp || !draft.changeNote.trim()}
              onClick={() => void submit()}
            >
              提交提议
            </Button>
          )}
        </Space>
      </Space>
    </Modal>
  );
}
