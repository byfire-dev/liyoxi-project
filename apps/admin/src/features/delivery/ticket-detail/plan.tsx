import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Drawer, Input, Select } from "antd";
import { useState } from "react";
import { FormField } from "../../../components/FormField";
import { Can } from "../../../lib/permissions";
import { DICT_QUERY } from "../../../lib/query";
import type { DetailApi, DraftBody, Plan } from "./api";
import { DETAIL_KEY, planInput } from "./model";
import { useDeliveryWrite } from "./write";
export function PlanDrawer({
  plan,
  api,
  onClose,
  onRefresh,
}: {
  plan: Plan;
  api: DetailApi;
  onClose(): void;
  onRefresh(): void;
}) {
  const [content, setContent] = useState(() => planInput(plan)),
    [version, setVersion] = useState(plan.draftLockVersion);
  const focus = useQuery({ queryKey: [...DETAIL_KEY, "focus"], queryFn: api.focus, ...DICT_QUERY });
  const order = useQuery({
    queryKey: [...DETAIL_KEY, "order", plan.orderId],
    queryFn: () => api.order(plan.orderId),
    ...DICT_QUERY,
  });
  const write = useDeliveryWrite(() => {
    onRefresh();
    onClose();
  });
  const globalEditable = plan.itemWindows.every((w) => w.canChangeContent);
  const update = (index: number, patch: Partial<DraftBody["content"]["items"][number]>) =>
    setContent((old) => ({
      ...old,
      items: old.items.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  const valid = content.focusCodes.length > 0 && (content.note?.length ?? 0) <= 200;
  return (
    <Drawer
      open
      title="配置交付方案"
      size={680}
      onClose={() => {
        if (!write.pending) onClose();
      }}
      closable={!write.pending}
      mask={{ closable: !write.pending }}
    >
      <div className="lyx-production-form">
        <p>商家自助发布 · 广告位：暂无</p>
        <FormField label="定制重点">
          {(field) => (
            <Select
              {...field}
              mode="multiple"
              value={content.focusCodes}
              disabled={!globalEditable || write.pending}
              loading={focus.isPending}
              onChange={(focusCodes: string[]) => setContent({ ...content, focusCodes })}
              options={
                focus.data?.items
                  .filter((r) => r.isEnabled)
                  .map((r) => ({ value: r.code, label: r.name })) ?? []
              }
            />
          )}
        </FormField>
        {focus.isError ? <Alert type="error" title={focus.error.message} /> : null}
        <FormField label="补充说明" value={content.note ?? ""} maxLength={200}>
          {(field) => (
            <Input.TextArea
              {...field}
              value={content.note ?? ""}
              rows={3}
              maxLength={200}
              disabled={!globalEditable || write.pending}
              onChange={(e) => setContent({ ...content, note: e.target.value || null })}
            />
          )}
        </FormField>
        <p>
          参考素材：
          {plan.draft.referenceAssets.map((r) => r.title ?? r.storeAssetId).join("、") || "暂无"}
        </p>
        {content.items.map((item, index) => {
          const source = plan.draft.items[index]!,
            window = plan.itemWindows.find((r) => r.orderItemId === item.orderItemId);
          const accounts =
            order.data?.items.find((r) => r.orderItemId === item.orderItemId)?.accounts ?? [];
          return (
            <section className="lyx-production-card" key={item.orderItemId}>
              <h3>
                {source.dramaTitle} · {source.episodeCount} 集
              </h3>
              <FormField label="发布账号">
                {(field) => (
                  <Select
                    {...field}
                    mode="multiple"
                    value={item.channelAccountIds}
                    loading={order.isPending}
                    disabled={!window?.canChangeAccounts || write.pending || order.isError}
                    options={accounts.map((a) => ({
                      value: a.channelAccountId,
                      label: a.accountName,
                    }))}
                    onChange={(channelAccountIds: string[]) => update(index, { channelAccountIds })}
                  />
                )}
              </FormField>
              <div className="lyx-production-two">
                <FormField label="约定上线日">
                  {(field) => (
                    <Input
                      {...field}
                      type="date"
                      value={item.agreedLaunchDate ?? ""}
                      disabled={!window?.canReschedule || write.pending}
                      onChange={(e) => update(index, { agreedLaunchDate: e.target.value || null })}
                    />
                  )}
                </FormField>
                <FormField label="预计交付日">
                  {(field) => (
                    <Input
                      {...field}
                      type="date"
                      value={item.expectedDeliveryDate ?? ""}
                      disabled={!window?.canChangeContent || write.pending}
                      onChange={(e) =>
                        update(index, { expectedDeliveryDate: e.target.value || null })
                      }
                    />
                  )}
                </FormField>
              </div>
              <p>广告位：暂无</p>
            </section>
          );
        })}
        {order.isError ? <Alert type="error" title={order.error.message} /> : null}
        {write.error ? (
          <Alert
            type="error"
            title={write.error}
            action={
              <Button
                disabled={write.pending}
                onClick={() => {
                  void api
                    .plan(plan.deliveryPlanId)
                    .then((latest) => {
                      setVersion(latest.draftLockVersion);
                      write.setError(undefined);
                      onRefresh();
                    })
                    .catch((e: unknown) =>
                      write.setError(e instanceof Error ? e.message : "刷新失败，请重试"),
                    );
                }}
              >
                刷新版本并保留输入
              </Button>
            }
          />
        ) : null}
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {plan.actions.includes("draft-replace") ? (
            <Can module="delivery" need="o" action="delivery.plan.edit">
              <Button
                type="primary"
                loading={write.pending}
                disabled={!valid || focus.isError || order.isError}
                onClick={() =>
                  void write.submit(
                    { id: plan.deliveryPlanId, draftLockVersion: version, content },
                    (key) =>
                      api.draft(plan.deliveryPlanId, { draftLockVersion: version, content }, key),
                  )
                }
              >
                保存方案
              </Button>
            </Can>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
