import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Drawer, Input, Select } from "antd";
import { useContext, useEffect, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { AccessContext, Can } from "../../../lib/permissions";
import { actorScope } from "../../system/staff-access";
import { DETAIL_QUERY, DICT_QUERY } from "../../../lib/query";
import type { DetailApi, DraftBody, Plan } from "./api";
import { DETAIL_KEY, planInput } from "./model";
import { usePublishWrite } from "./publish-write";
import { allPublishAccounts, publishError } from "./publish-api";
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
  const scope = actorScope(useContext(AccessContext));
  const order = useQuery({
    queryKey: [...DETAIL_KEY, scope, "available-accounts", plan.store.storeId],
    queryFn: ({ signal }) => allPublishAccounts(api.publish, plan.store.storeId, signal),
    ...DETAIL_QUERY,
  });
  const write = usePublishWrite();
  const [confirmed, setConfirmed] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [refreshError, setRefreshError] = useState<string>();
  const [windows, setWindows] = useState(plan.itemWindows);
  const lifetime = useRef<AbortController | null>(null),
    refreshBusy = useRef(false);
  useEffect(() => {
    const own = new AbortController();
    lifetime.current = own;
    return () => own.abort();
  }, []);
  const blocked = write.pending || write.phase !== "idle" || refreshing;
  const available = new Set(order.data?.map((a) => a.channelAccountId) ?? []);
  const globalEditable = windows.every((w) => w.canChangeContent);
  const update = (index: number, patch: Partial<DraftBody["content"]["items"][number]>) => {
    setConfirmed(false);
    setContent((old) => ({
      ...old,
      items: old.items.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  };
  const valid =
    content.focusCodes.length > 0 &&
    (content.note?.length ?? 0) <= 200 &&
    !!order.data &&
    content.items.every(
      (item) =>
        !windows.find((w) => w.orderItemId === item.orderItemId)?.canChangeAccounts ||
        (item.channelAccountIds.length > 0 &&
          item.channelAccountIds.every((id) => available.has(id))),
    );
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
              disabled={!globalEditable || blocked}
              loading={focus.isPending}
              onChange={(focusCodes: string[]) => {
                setConfirmed(false);
                setContent({ ...content, focusCodes });
              }}
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
              disabled={!globalEditable || blocked}
              onChange={(e) => {
                setConfirmed(false);
                setContent({ ...content, note: e.target.value || null });
              }}
            />
          )}
        </FormField>
        <p>
          参考素材：
          {plan.draft.referenceAssets.map((r) => r.title ?? r.storeAssetId).join("、") || "暂无"}
        </p>
        {content.items.map((item, index) => {
          const source = plan.draft.items[index]!,
            window = windows.find((r) => r.orderItemId === item.orderItemId);
          const accounts = order.data ?? [];
          const unavailable = item.channelAccountIds.filter((id) => !available.has(id));
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
                    disabled={
                      !window?.canChangeAccounts || blocked || order.isError || order.isPending
                    }
                    options={[
                      ...accounts.map((a) => ({
                        value: a.channelAccountId,
                        label: `${a.accountName} · ${a.platform === "douyin" ? "抖音" : "视频号"}`,
                      })),
                      ...unavailable.map((id) => ({
                        value: id,
                        label: `${source.accounts.find((a) => a.channelAccountId === id)?.accountName ?? "已选账号"}（当前不可用）`,
                        disabled: true,
                      })),
                    ]}
                    onChange={(channelAccountIds: string[]) => update(index, { channelAccountIds })}
                  />
                )}
              </FormField>
              {unavailable.length > 0 && order.isSuccess ? (
                <Alert
                  type="warning"
                  title="已选账号中有当前不可用项，未自动移除"
                  action={
                    window?.canChangeAccounts ? (
                      <Button
                        disabled={blocked}
                        onClick={() =>
                          update(index, {
                            channelAccountIds: item.channelAccountIds.filter((id) =>
                              available.has(id),
                            ),
                          })
                        }
                      >
                        移除失效账号
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}
              <div className="lyx-production-two">
                <FormField label="约定上线日">
                  {(field) => (
                    <Input
                      {...field}
                      type="date"
                      value={item.agreedLaunchDate ?? ""}
                      disabled={!window?.canReschedule || blocked}
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
                      disabled={!window?.canChangeContent || blocked}
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
            title={publishError(write.error)}
            action={
              <Button
                disabled={write.pending}
                onClick={() => {
                  if (refreshBusy.current || write.phase !== "blocked") return;
                  refreshBusy.current = true;
                  setRefreshing(true);
                  void api
                    .plan(plan.deliveryPlanId, lifetime.current!.signal)
                    .then((latest) => {
                      if (lifetime.current?.signal.aborted) return;
                      setVersion(latest.draftLockVersion);
                      setWindows(latest.itemWindows);
                      setConfirmed(false);
                      write.clear();
                      setRefreshError(undefined);
                      onRefresh();
                      void order.refetch();
                    })
                    .catch((e: unknown) => {
                      if (!lifetime.current?.signal.aborted) setRefreshError(publishError(e));
                    })
                    .finally(() => {
                      if (!lifetime.current?.signal.aborted) {
                        refreshBusy.current = false;
                        setRefreshing(false);
                      }
                    });
                }}
                hidden={write.phase !== "blocked"}
              >
                刷新版本并保留输入
              </Button>
            }
          />
        ) : null}
        {refreshError ? <Alert type="error" title={refreshError} /> : null}
        <Checkbox
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        >
          我已核对全部发布账号与方案
        </Checkbox>
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {plan.actions.includes("draft-replace") ? (
            <Can module="delivery" need="o" action="delivery.plan.edit">
              <Button
                type="primary"
                loading={write.pending}
                disabled={
                  (write.phase === "idle" &&
                    (!valid || !confirmed || focus.isError || order.isError)) ||
                  write.phase === "blocked" ||
                  refreshing
                }
                onClick={() =>
                  void write
                    .run(
                      { id: plan.deliveryPlanId, draftLockVersion: version, content },
                      (key, signal) =>
                        api.draft(
                          plan.deliveryPlanId,
                          { draftLockVersion: version, content },
                          key,
                          signal,
                        ),
                      (signal) => api.plan(plan.deliveryPlanId, signal),
                    )
                    .then((done) => {
                      if (done) {
                        onRefresh();
                        onClose();
                      }
                    })
                }
              >
                {write.phase === "accepted" ? "重试读取方案结果" : "保存方案"}
              </Button>
            </Can>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
