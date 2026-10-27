import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Form, Input, Select, Skeleton } from "antd";
import { useEffect, useMemo, useState } from "react";
import { PlanAdminQuoteBodySchema } from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { ErrorState } from "../../../components/StateBlock";
import { InfoList } from "../../../components/InfoList";
import { BillingDialog } from "../../billing/plans/dialog";
import { billingError, createPlansApi } from "../../billing/plans/api";
import { createPointPacksApi } from "../../billing/point-packs/api";
import { createAccountsApi, type AccountRow } from "../../billing/accounts/api";
import {
  createBillingIntent,
  createBillingRead,
  moneyText,
  pointsText,
} from "../../billing/plans/model";
import { createPaymentOrdersApi, type PaymentDetail } from "../orders/payment-api";
import {
  offlineBody,
  snapshotOfflinePack,
  type OfflineDraft,
  type BoundEntityQuote,
} from "./model";
import { ProofDialog } from "./proof";
export function OfflinePaymentDialog({
  services,
  scope,
  canUpload,
  onClose,
  onCreated,
  onProofSaved,
}: {
  services: AppServices;
  scope: string;
  canUpload: boolean;
  onClose(): void;
  onCreated(row: PaymentDetail): void;
  onProofSaved(): void;
}) {
  const [created, setCreated] = useState<PaymentDetail>(),
    api = useMemo(() => createPaymentOrdersApi(services), [services]);
  if (created)
    return (
      <ProofDialog
        key={created.paymentOrderId}
        order={created}
        api={api}
        services={services}
        scope={scope}
        canUpload={canUpload}
        onClose={onClose}
        onSaved={onProofSaved}
      />
    );
  return (
    <CreateOfflineDialog
      services={services}
      scope={scope}
      onClose={onClose}
      onCreated={(row) => {
        setCreated(row);
        onCreated(row);
      }}
    />
  );
}
function CreateOfflineDialog({
  services,
  scope,
  onClose,
  onCreated,
}: {
  services: AppServices;
  scope: string;
  onClose(): void;
  onCreated(row: PaymentDetail): void;
}) {
  const api = useMemo(() => createPaymentOrdersApi(services), [services]),
    plansApi = useMemo(() => createPlansApi(services), [services]),
    packsApi = useMemo(() => createPointPacksApi(services), [services]),
    accountsApi = useMemo(() => createAccountsApi(services), [services]);
  const [form] = Form.useForm<OfflineDraft>(),
    [intent] = useState(() => createBillingIntent("offline-payment-create")),
    [reader] = useState(createBillingRead),
    [account, setAccount] = useState<AccountRow>(),
    [q, setQ] = useState(""),
    [quote, setQuote] = useState<BoundEntityQuote>(),
    [selectedPack, setSelectedPack] = useState<ReturnType<typeof snapshotOfflinePack>>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [confirmed, setConfirmed] = useState(false);
  const kind = Form.useWatch("kind", form),
    purchaseIntent = Form.useWatch("intent", form);
  const accounts = useQuery({
      queryKey: ["billing", scope, "offline-accounts", q],
      queryFn: ({ signal }) =>
        accountsApi.list(
          { q: q.trim() || undefined, page: 1, pageSize: 20, sort: "-updatedAt" },
          signal,
        ),
    }),
    plans = useQuery({
      queryKey: ["billing", scope, "offline-plans"],
      queryFn: ({ signal }) => plansApi.list(false, signal),
    }),
    packs = useQuery({
      queryKey: ["billing", scope, "offline-packs"],
      queryFn: ({ signal }) => packsApi.list("true", signal),
    });
  useEffect(() => {
    reader.activate();
    return () => reader.close();
  }, [reader]);
  const invalidate = () => {
    reader.invalidate();
    intent.change();
    setQuote(undefined);
    setConfirmed(false);
    setError(undefined);
    setPending(false);
  };
  const pack = selectedPack,
    amount = kind === "plan" ? quote?.result.quote.payFen : pack?.priceFen;
  return (
    <BillingDialog
      title="线下开立付款单"
      intent={intent}
      onClose={onClose}
      submitText="建立待付款单"
      disabled={!account || !confirmed || amount === undefined || pending}
      submit={async () => {
        if (!account) return;
        const body = offlineBody(account, await form.validateFields(), { quote, pack });
        const result = await intent.submit(body, (key, signal) => api.create(body, key, signal));
        if (result !== undefined) {
          if (result.entity.entityId !== account.entity.entityId)
            throw new Error("付款单主体不一致，请刷新核对");
          onCreated(result);
        }
      }}
    >
      <Alert
        type="info"
        title="仅建立对公转账待付款单；受真实开单开关、收款资料与主体权限控制。凭证代传在建单成功后另行处理。"
      />
      <Form.Item label="付款主体" required>
        {accounts.isError ? (
          <ErrorState
            message="无法读取主体账户，请确认当前读取权限后重试"
            onRetry={() => void accounts.refetch()}
          />
        ) : (
          <Select
            aria-label="付款主体"
            showSearch
            filterOption={false}
            loading={accounts.isFetching}
            value={account?.pointAccountId}
            onSearch={setQ}
            placeholder="搜索主体或门店（最多20条，请精确搜索）"
            options={accounts.data?.items.map((a) => ({
              value: a.pointAccountId,
              label: `${a.entity.name} · ${a.entity.primaryStoreName ?? "无主门店"}`,
            }))}
            onChange={(id) => {
              setAccount(
                structuredClone(accounts.data?.items.find((a) => a.pointAccountId === id)),
              );
              form.setFieldsValue({ storeId: undefined });
              invalidate();
            }}
          />
        )}
      </Form.Item>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: "plan", intent: "renew_next_term", contractNo: "" }}
        onValuesChange={invalidate}
      >
        <Form.Item name="storeId" label="关联门店ID（选填，须属当前主体）">
          <Input />
        </Form.Item>
        <Form.Item name="kind" label="付款内容" rules={[{ required: true }]}>
          <Select
            options={[
              { value: "plan", label: "套餐订购 / 续费 / 升级" },
              { value: "topup", label: "积分包" },
            ]}
          />
        </Form.Item>
        {kind === "plan" ? (
          <>
            {plans.isPending ? (
              <Skeleton active />
            ) : plans.isError ? (
              <ErrorState onRetry={() => void plans.refetch()} />
            ) : (
              <Form.Item name="planId" label="目标套餐" rules={[{ required: true }]}>
                <Select
                  options={plans.data.items
                    .filter((p) => p.isListed && p.current)
                    .map((p) => ({ value: p.planId, label: p.name }))}
                />
              </Form.Item>
            )}
            <Form.Item name="intent" label="生效方式">
              <Select
                options={[
                  { value: "renew_next_term", label: "按服务端判定开通 / 下期续费" },
                  { value: "upgrade_now", label: "本期立即升级" },
                ]}
              />
            </Form.Item>
            {purchaseIntent !== "upgrade_now" ? (
              <Form.Item name="months" label="购买周期" rules={[{ required: true }]}>
                <Select
                  options={plans.data?.enabledCycles.current.map((m) => ({
                    value: m,
                    label: `${m}个月`,
                  }))}
                />
              </Form.Item>
            ) : null}
          </>
        ) : packs.isPending ? (
          <Skeleton active />
        ) : packs.isError ? (
          <ErrorState onRetry={() => void packs.refetch()} />
        ) : (
          <Form.Item name="pointPackId" label="积分包" rules={[{ required: true }]}>
            <Select
              onChange={(id) =>
                setSelectedPack(
                  snapshotOfflinePack(packs.data?.items.find((p) => p.pointPackId === id)),
                )
              }
              options={packs.data.items
                .filter((p) => p.isListed)
                .map((p) => ({
                  value: p.pointPackId,
                  label: `${p.points}积分 · ${moneyText(p.priceFen)}`,
                }))}
            />
          </Form.Item>
        )}
        <Form.Item
          name="contractNo"
          label="合同编号"
          rules={[{ required: true, whitespace: true, max: 64 }]}
        >
          <Input maxLength={64} />
        </Form.Item>
      </Form>
      {kind === "plan" ? (
        <Button
          disabled={!account}
          loading={pending}
          onClick={() =>
            void (async () => {
              try {
                if (!account) return;
                const draft = await form.validateFields();
                const body = PlanAdminQuoteBodySchema.parse({
                  kind: draft.intent === "upgrade_now" ? "upgrade" : "renewal",
                  pointAccountId: account.pointAccountId,
                  planId: draft.planId,
                  ...(draft.intent ? { intent: draft.intent } : {}),
                  ...(draft.intent !== "upgrade_now" ? { months: draft.months } : {}),
                });
                setQuote(undefined);
                setConfirmed(false);
                setPending(true);
                setError(undefined);
                const result = await reader.run((signal) => plansApi.quote(body, signal));
                if (result !== undefined) {
                  if (result.scope !== "entity") throw new Error("必须使用当前主体真实报价");
                  setQuote({
                    accountId: account.pointAccountId,
                    planId: body.planId,
                    months: body.months,
                    intent: body.intent,
                    result,
                  });
                  setPending(false);
                }
              } catch (cause) {
                setError(billingError(cause));
                setPending(false);
              }
            })()
          }
        >
          获取本主体报价
        </Button>
      ) : null}
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {account && amount !== undefined ? (
        <>
          <InfoList
            items={[
              { label: "主体", value: account.entity.name },
              { label: "应付", value: moneyText(amount) },
              ...(quote && kind === "plan"
                ? [
                    { label: "计价说明", value: quote.result.quote.formula.text },
                    {
                      label: "生效",
                      value:
                        quote.result.quote.effectiveMode === "immediate" ? "立即生效" : "后续周期",
                    },
                    {
                      label: "新周期",
                      value: quote.result.quote.newTerm
                        ? `${quote.result.quote.newTerm.startDate} 至 ${quote.result.quote.newTerm.endDate}`
                        : "沿用原周期",
                    },
                    {
                      label: "本月补发积分",
                      value: pointsText(quote.result.quote.upgrade?.topupPoints),
                    },
                  ]
                : []),
              ...(pack && kind === "topup"
                ? [{ label: "积分", value: pointsText(pack.points) }]
                : []),
            ]}
          />
          <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
            已核对主体、合同、服务端金额与生效说明
          </Checkbox>
        </>
      ) : null}
    </BillingDialog>
  );
}
