import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Button, Form, Input, InputNumber, Select, Skeleton, Table, type TableProps } from "antd";
import { useContext, useMemo, useState } from "react";
import { fenToYuan, formatSignedPercent } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { AccessContext, canAction } from "../../../lib/permissions";
import { LIST_QUERY, DETAIL_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { billingScope, createBillingIntent, moneyText, pointsText } from "../plans/model";
import { BillingDialog } from "../plans/dialog";
import { BillingConfirm } from "../plans/confirm";
import { createPointPacksApi, type PointPack, type PointPacksApi } from "./api";
import { packBody, packSearch, type PackDraft } from "./model";
const route = getRouteApi("/billing/point-packs");
export function PointPacksPage() {
  return <PointPacksWorkspace key={billingScope(useContext(AccessContext))} />;
}
function PointPacksWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    search = packSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createPointPacksApi(services), [services]);
  const list = useQuery({
      queryKey: ["billing", scope, "packs", search.listed],
      queryFn: ({ signal }) => api.list(search.listed, signal),
      ...LIST_QUERY,
    }),
    summary = useQuery({
      queryKey: ["billing", scope, "pack-summary"],
      queryFn: ({ signal }) => api.summary(signal),
      ...DETAIL_QUERY,
    });
  const [editing, setEditing] = useState<{ row?: PointPack }>(),
    [listing, setListing] = useState<{ row: PointPack; action: "shelve" | "delist" }>();
  const canEdit = canAction(access, "billing.pack.edit"),
    refresh = () => {
      void list.refetch();
      void summary.refetch();
    },
    saved = () => {
      showSuccessNotice("积分包已更新");
      refresh();
      setEditing(undefined);
      setListing(undefined);
    };
  const columns: NonNullable<TableProps<PointPack>["columns"]> = [
    {
      title: "积分包",
      key: "points",
      render: (_, row) => <strong>{pointsText(row.points)}</strong>,
    },
    { title: "售价", key: "price", align: "right", render: (_, row) => moneyText(row.priceFen) },
    {
      title: "本月售出",
      key: "sales",
      render: (_, row) => `${row.soldThisMonthCount} 笔 · ${moneyText(row.soldThisMonthFen)}`,
    },
    {
      title: "状态 / 排序",
      key: "status",
      render: (_, row) => `${row.isListed ? "已上架" : "已下架"} · ${row.position}`,
    },
    {
      title: "更新时间",
      key: "at",
      render: (_, row) => appDateTimeFormat.dateTimeFull(row.updatedAt),
    },
    {
      title: "操作",
      key: "actions",
      render: (_, row) => (
        <div className="billing-actions">
          {canEdit && row.actions.includes("update") ? (
            <Button size="small" onClick={() => setEditing({ row: structuredClone(row) })}>
              编辑
            </Button>
          ) : null}
          {canEdit ? (
            row.actions
              .filter((a): a is "shelve" | "delist" => a === "shelve" || a === "delist")
              .map((action) => (
                <Button
                  key={action}
                  size="small"
                  danger={action === "delist"}
                  onClick={() => setListing({ row: structuredClone(row), action })}
                >
                  {action === "shelve" ? "上架" : "下架"}
                </Button>
              ))
          ) : (
            <span>只读</span>
          )}
        </div>
      ),
    },
  ];
  return (
    <div className="billing-stack">
      <PageHeader
        title="积分包管理"
        subtitle="修改仅影响之后的购买；已有付款单价格保持。"
        extra={
          canEdit ? (
            <Button type="primary" onClick={() => setEditing({})}>
              新增积分包
            </Button>
          ) : undefined
        }
      />
      {summary.isError ? (
        <ErrorState onRetry={() => void summary.refetch()} />
      ) : (
        <section className="lyx-card billing-panel" aria-label="加购统计">
          <div className="billing-kpis">
            <span>
              本月笔数 <strong>{summary.data?.topupCount ?? "—"}</strong>
            </span>
            <span>
              本月金额 <strong>{moneyText(summary.data?.topupFen)}</strong>
            </span>
            <span>
              加购主体 <strong>{summary.data?.topupEntityCount ?? "—"}</strong>
            </span>
            <span>
              加购比例{" "}
              {summary.data?.topupRateBp == null
                ? "—"
                : formatSignedPercent(summary.data.topupRateBp).replace(/^\+/, "")}
            </span>
          </div>
          <h2>近6个月加购积分</h2>
          <div className="billing-actions">
            {summary.data?.monthly.map((m) => (
              <ReadOnlyValue
                key={m.month}
                label={`${m.month}${m.isCurrent ? "（本月）" : ""}`}
                value={pointsText(m.points)}
              />
            ))}
          </div>
        </section>
      )}
      <section className="lyx-card billing-panel">
        <Select
          aria-label="积分包状态"
          value={search.listed ?? "all"}
          options={[
            { value: "all", label: "全部状态" },
            { value: "true", label: "已上架" },
            { value: "false", label: "已下架" },
          ]}
          onChange={(value) =>
            void navigate({ search: packSearch({ listed: value === "all" ? undefined : value }) })
          }
        />
        {list.isPending ? (
          <Skeleton active />
        ) : list.isError ? (
          <ErrorState onRetry={refresh} />
        ) : list.data.items.length === 0 ? (
          <EmptyState title="暂无积分包" />
        ) : (
          <div className="billing-table">
            <Table<PointPack>
              rowKey="pointPackId"
              columns={columns}
              dataSource={list.data.items}
              pagination={false}
            />
          </div>
        )}
      </section>
      {editing ? (
        <PackDialog
          key={editing.row?.pointPackId ?? "new"}
          api={api}
          row={editing.row}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {listing ? (
        <BillingConfirm
          key={`${listing.row.pointPackId}:${listing.action}`}
          action={`pack-${listing.action}`}
          spec={{
            title: listing.action === "shelve" ? "上架积分包" : "下架积分包",
            echo: [
              { label: "积分", value: pointsText(listing.row.points) },
              { label: "售价", value: moneyText(listing.row.priceFen), emphasis: true },
            ],
            checkLabel: "已核对积分包与售价",
            danger: listing.action === "delist",
          }}
          submit={(key, signal) => api[listing.action](listing.row.pointPackId, key, signal)}
          onClose={() => setListing(undefined)}
          onSaved={saved}
          onConflict={refresh}
        />
      ) : null}
    </div>
  );
}
function PackDialog({
  api,
  row,
  onClose,
  onSaved,
}: {
  api: PointPacksApi;
  row?: PointPack;
  onClose(): void;
  onSaved(): void;
}) {
  const [form] = Form.useForm<PackDraft>(),
    [intent] = useState(() => createBillingIntent(row ? "pack-edit" : "pack-create"));
  return (
    <BillingDialog
      title={row ? "编辑积分包" : "新增积分包（保存后上架）"}
      intent={intent}
      onClose={onClose}
      submit={async () => {
        const draft = await form.validateFields(),
          body = packBody(draft, row);
        const result = await intent.submit(body, (key, signal) =>
          row
            ? api.update(row.pointPackId, { ...body, lockVersion: row.lockVersion }, key, signal)
            : api.create(body, key, signal),
        );
        if (result !== undefined) {
          onSaved();
          onClose();
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          points: row?.points ?? 1000,
          priceYuan: row ? fenToYuan(row.priceFen) : "",
          position: row?.position ?? 0,
        }}
        onValuesChange={() => intent.change()}
      >
        <Form.Item name="points" label="积分数量（至少100）" rules={[{ required: true }]}>
          <InputNumber min={100} precision={0} />
        </Form.Item>
        <Form.Item name="priceYuan" label="售价（元）" rules={[{ required: true }]}>
          <Input inputMode="decimal" placeholder="如：1000.00" />
        </Form.Item>
        <Form.Item name="position" label="显示顺序" rules={[{ required: true }]}>
          <InputNumber precision={0} />
        </Form.Item>
        {row ? (
          <ReadOnlyValue
            label="当前版本"
            value={String(row.lockVersion)}
            reason="保存使用打开时看到的版本，冲突后请重新核对。"
          />
        ) : null}
      </Form>
    </BillingDialog>
  );
}
