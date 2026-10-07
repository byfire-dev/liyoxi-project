import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useState } from "react";

import { ConfigPage } from "../../../components/ConfigPage";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { PageHeader } from "../../../components/PageHeader";
import {
  QueryTablePage,
  type QueryColumn,
  type QueryState,
} from "../../../components/QueryTablePage";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { useCan } from "../../../lib/permissions";
import { DICT_QUERY } from "../../../lib/query";
import { writeTableSearch } from "../../../lib/table-search";
import { configResult, errorMessage, failureFields } from "./api";
import {
  CHECKLIST_CODES,
  CONFIG_KEY,
  checklistBody,
  configTableSearch,
  createConfigIntent,
  type Checklist,
  type ChecklistBody,
} from "./model";
import { DraftRejected, ErrorSummary, UnsavedGuard } from "./private-controls";
import "./config.css";

const route = getRouteApi("/sys/checklists");
const statuses: Record<string, string> = { draft: "草稿", active: "启用", retired: "已退役" };
export function ChecklistsPage() {
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    raw = route.useSearch(),
    search = configTableSearch(raw, true);
  const canEdit = useCan("flow.checklist.manage");
  const [editing, setEditing] = useState<{ source?: Checklist }>();
  const [action, setAction] = useState<{ row: Checklist; action: "activate" | "discard" }>(),
    [notice, setNotice] = useState<string>();
  const list = useQuery({
    queryKey: [...CONFIG_KEY, "checklists", canEdit],
    queryFn: async () =>
      (
        await configResult(
          await services.api.client.GET("/api/v1/admin/checklist-templates", {
            params: { query: { allVersions: canEdit ? "true" : "false" } },
          }),
        )
      ).items as unknown as Checklist[],
    ...DICT_QUERY,
  });
  const detail = list.data?.find((row) => row.checklistTemplateId === raw.id);
  const filtered =
    list.data?.filter(
      (row) =>
        (!search.filters.code || row.code === search.filters.code) &&
        (!search.filters.status || row.status === search.filters.status) &&
        (!search.q ||
          `${row.code} ${row.items.map((item) => item.label).join(" ")}`.includes(search.q)),
    ) ?? [];
  const query: QueryState<Checklist> = list.isPending
    ? { status: "loading" }
    : list.isError
      ? { status: "error", message: errorMessage(list.error) }
      : {
          status: "success",
          items: filtered.slice((search.page - 1) * search.pageSize, search.page * search.pageSize),
          total: filtered.length,
        };
  const columns: QueryColumn<Checklist>[] = [
    { key: "code", title: "编码", render: (row) => row.code },
    { key: "version", title: "版本", width: 80, render: (row) => row.versionNo },
    {
      key: "status",
      title: "状态",
      width: 90,
      render: (row) => statuses[row.status] ?? row.status,
    },
    { key: "items", title: "条目", width: 80, render: (row) => row.items.length },
    {
      key: "actions",
      title: "操作",
      width: 240,
      render: (row) => (
        <div className="lyx-config-actions">
          <Button
            type="link"
            onClick={() => {
              void navigate({
                search: { ...writeTableSearch(search), id: row.checklistTemplateId },
              });
            }}
          >
            查看
          </Button>
          {canEdit && row.actions.includes("activate") ? (
            <Button type="link" onClick={() => setAction({ row, action: "activate" })}>
              启用
            </Button>
          ) : null}
          {canEdit && row.actions.includes("discard") ? (
            <Button type="link" danger onClick={() => setAction({ row, action: "discard" })}>
              放弃
            </Button>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="清单模板管理"
        subtitle="新版本先存为草稿；启用会让同编码旧版本退役。既有业务快照保持只读。"
        extra={
          canEdit ? (
            <Button type="primary" onClick={() => setEditing({})}>
              新建清单版本
            </Button>
          ) : undefined
        }
      />
      {notice ? <Alert type="success" title={notice} /> : null}
      <QueryTablePage
        label="清单模板"
        search={search}
        onSearchChange={(next) =>
          void navigate({
            search: writeTableSearch(configTableSearch(writeTableSearch(next), true)),
          })
        }
        keywordPlaceholder="搜索清单编码或条目"
        filters={[
          {
            key: "code",
            placeholder: "全部编码",
            options: CHECKLIST_CODES.map((code) => ({ value: code, label: code })),
          },
          {
            key: "status",
            placeholder: "全部状态",
            options: Object.entries(statuses).map(([value, label]) => ({ value, label })),
          },
        ]}
        columns={columns}
        rowKey={(row) => row.checklistTemplateId}
        query={query}
        onRetry={() => void list.refetch()}
        empty={{ title: "暂无清单模板" }}
      />
      {detail ? (
        <Modal
          open
          title={`清单 ${detail.code} · 版本 ${detail.versionNo}`}
          footer={
            <Button
              onClick={() => {
                void navigate({ search: writeTableSearch(search) });
              }}
            >
              关闭
            </Button>
          }
          onCancel={() => {
            void navigate({ search: writeTableSearch(search) });
          }}
          destroyOnHidden
        >
          <ReadOnlyValue label="状态" value={statuses[detail.status]} />
          <p>历史条目只读；修改通过新版本完成，既有业务提交不会自动升级。</p>
          {detail.items.map((item) => (
            <ReadOnlyValue
              key={item.key}
              label={`${item.key} · ${item.label}`}
              value={`${item.required ? "必填" : "选填"} · ${item.allowNa ? "允许不适用" : "不允许不适用"} · ${item.merchantVisible ? "向商家显示" : "内部显示"}${item.hint ? ` · ${item.hint}` : ""}`}
            />
          ))}
          {canEdit ? (
            <Button
              onClick={() => {
                setEditing({ source: detail });
                void navigate({ search: writeTableSearch(search) });
              }}
            >
              {detail.status === "draft" ? "放弃旧草稿并创建修订版本" : "以此创建新版本"}
            </Button>
          ) : null}
        </Modal>
      ) : null}
      {editing ? (
        <ChecklistEditor
          source={editing.source}
          close={() => setEditing(undefined)}
          save={async (body, key) => {
            try {
              if (editing.source?.status === "draft")
                await configResult(
                  await services.api.client.POST(
                    "/api/v1/admin/checklist-templates/{checklistTemplateId}/discard",
                    {
                      params: { path: { checklistTemplateId: editing.source.checklistTemplateId } },
                      headers: { "Idempotency-Key": `${key}_discard` },
                    },
                  ),
                );
              await configResult(
                await services.api.client.POST("/api/v1/admin/checklist-templates", {
                  body,
                  headers: { "Idempotency-Key": key },
                }),
              );
              await list.refetch();
              setEditing(undefined);
              setNotice("新的草稿版本已建立并重新读取；尚未启用");
              return {};
            } catch (error) {
              await list.refetch();
              return { message: errorMessage(error), errors: failureFields(error) };
            }
          }}
        />
      ) : null}
      {action ? (
        <ConfirmAction
          open
          action={`checklist-${action.action}`}
          spec={{
            title: action.action === "activate" ? "启用清单版本" : "放弃清单草稿",
            echo: [
              { label: "编码", value: action.row.code },
              { label: "版本", value: String(action.row.versionNo) },
              { label: "条目数", value: String(action.row.items.length) },
            ],
            description:
              action.action === "activate"
                ? "同编码的旧启用版本将退役，既有业务快照不变。"
                : "草稿将退役，历史仍可读取。",
            checkLabel: "我已核对版本与影响",
            danger: action.action === "discard",
          }}
          onCancel={() => setAction(undefined)}
          onDone={() => {
            setAction(undefined);
            setNotice("清单状态已更新并重新读取");
          }}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              if (action.action === "activate")
                await configResult(
                  await services.api.client.POST(
                    "/api/v1/admin/checklist-templates/{checklistTemplateId}/activate",
                    {
                      params: { path: { checklistTemplateId: action.row.checklistTemplateId } },
                      headers: { "Idempotency-Key": idempotencyKey },
                    },
                  ),
                );
              else
                await configResult(
                  await services.api.client.POST(
                    "/api/v1/admin/checklist-templates/{checklistTemplateId}/discard",
                    {
                      params: { path: { checklistTemplateId: action.row.checklistTemplateId } },
                      headers: { "Idempotency-Key": idempotencyKey },
                    },
                  ),
                );
              await list.refetch();
              return { outcome: "done" };
            } catch (error) {
              await list.refetch();
              return { outcome: "failed", message: errorMessage(error) };
            }
          }}
        />
      ) : null}
    </>
  );
}
function ChecklistEditor({
  source,
  close,
  save,
}: {
  source?: Checklist;
  close: () => void;
  save: (
    body: ChecklistBody,
    key: string,
  ) => Promise<{ message?: string; errors?: Record<string, string> }>;
}) {
  const initialItems = source?.items ?? [
    { key: "check", label: "", required: true, allowNa: false, merchantVisible: false },
  ];
  const [code, setCode] = useState(source?.code ?? CHECKLIST_CODES[0]),
    [items, setItems] = useState<ChecklistBody["items"]>(initialItems);
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<string>(),
    [busy, setBusy] = useState(false);
  const [intent] = useState(() => createConfigIntent("checklist-create"));
  const [replacement, setReplacement] = useState<ChecklistBody>();
  const dirty =
    code !== (source?.code ?? CHECKLIST_CODES[0]) ||
    JSON.stringify(items) !== JSON.stringify(initialItems);
  const change = (index: number, patch: Partial<ChecklistBody["items"][number]>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const cancel = () => {
    if (!dirty || window.confirm("放弃尚未保存的清单更改？")) close();
  };
  return (
    <Modal
      open
      title="新建清单版本"
      width={760}
      footer={null}
      onCancel={cancel}
      closable={!busy && !replacement}
      keyboard={!busy && !replacement}
      mask={{ closable: !busy && !replacement }}
      destroyOnHidden
    >
      <UnsavedGuard dirty={dirty} />
      <ConfigPage
        label="清单草稿"
        pending={busy || Boolean(replacement)}
        error={message}
        submitLabel={source?.status === "draft" ? "放弃旧草稿并创建新版本" : "创建草稿版本"}
        onSubmit={async () => {
          const result = checklistBody(code, items);
          setErrors(result.errors);
          if (!result.body) return;
          if (source?.status === "draft") {
            setReplacement(result.body);
            return;
          }
          setBusy(true);
          try {
            await intent.submit(result.body, async (key) => {
              const saved = await save(result.body!, key);
              if (saved.message || Object.keys(saved.errors ?? {}).length)
                throw new DraftRejected(saved.errors ?? {}, saved.message);
            });
          } catch (error) {
            setErrors(error instanceof DraftRejected ? error.fields : {});
            setMessage(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="清单编码">
          {(props) => (
            <Select
              {...props}
              aria-label="清单编码"
              value={code}
              disabled={Boolean(source)}
              options={CHECKLIST_CODES.map((value) => ({ value, label: value }))}
              onChange={setCode}
            />
          )}
        </FormField>
        {source?.status === "draft" ? (
          <Alert
            type="warning"
            title={`保存将先放弃旧草稿版本 ${source.versionNo}，再创建新版本；旧条目保留为历史。`}
          />
        ) : null}
        <div className="lyx-config-items">
          {items.map((item, index) => (
            <section className="lyx-config-item" key={index} aria-label={`清单条目 ${index + 1}`}>
              <div className="lyx-config-grid">
                <FormField label={`条目${index + 1}键`} error={errors[`items.${index}.key`]}>
                  {(props) => (
                    <Input
                      {...props}
                      value={item.key}
                      maxLength={40}
                      onChange={(event) => change(index, { key: event.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={`条目${index + 1}名称`} error={errors[`items.${index}.label`]}>
                  {(props) => (
                    <Input
                      {...props}
                      value={item.label}
                      maxLength={60}
                      onChange={(event) => change(index, { label: event.target.value })}
                    />
                  )}
                </FormField>
              </div>
              <div className="lyx-config-actions">
                <Checkbox
                  checked={item.required}
                  onChange={(event) => change(index, { required: event.target.checked })}
                >
                  必填
                </Checkbox>
                <Checkbox
                  checked={item.allowNa}
                  onChange={(event) => change(index, { allowNa: event.target.checked })}
                >
                  允许不适用
                </Checkbox>
                <Checkbox
                  checked={item.merchantVisible}
                  onChange={(event) => change(index, { merchantVisible: event.target.checked })}
                >
                  向商家显示
                </Checkbox>
                <Button
                  danger
                  size="small"
                  onClick={() => setItems(items.filter((_row, i) => i !== index))}
                >
                  移除条目{index + 1}
                </Button>
              </div>
              <FormField label={`条目${index + 1}提示`} error={errors[`items.${index}.hint`]}>
                {(props) => (
                  <Input
                    {...props}
                    value={item.hint ?? ""}
                    maxLength={100}
                    onChange={(event) => change(index, { hint: event.target.value || undefined })}
                  />
                )}
              </FormField>
            </section>
          ))}
        </div>
        <Button
          disabled={items.length >= 50}
          onClick={() =>
            setItems([
              ...items,
              {
                key: `check${items.length + 1}`,
                label: "",
                required: true,
                allowNa: false,
                merchantVisible: false,
              },
            ])
          }
        >
          增加条目
        </Button>
        <ErrorSummary errors={errors} />
        <Button onClick={cancel}>取消</Button>
      </ConfigPage>
      {replacement && source ? (
        <ConfirmAction
          open
          action="checklist-replace"
          spec={{
            title: "确认替换草稿版本",
            echo: [
              { label: "编码", value: source.code },
              { label: "旧草稿版本", value: String(source.versionNo) },
              { label: "新条目数", value: String(replacement.items.length) },
            ],
            description:
              "先放弃旧草稿，再创建新版本。两个步骤分别提交；创建失败时旧草稿仍可读为退役历史，重试沿用原幂等键。",
            checkLabel: "我已核对并确认退役旧草稿",
            danger: true,
          }}
          onCancel={() => setReplacement(undefined)}
          onDone={close}
          onConfirm={async ({ idempotencyKey }) => {
            const saved = await save(replacement, idempotencyKey);
            setErrors(saved.errors ?? {});
            return saved.message
              ? { outcome: "failed", message: saved.message }
              : { outcome: "done" };
          }}
        />
      ) : null}
    </Modal>
  );
}
