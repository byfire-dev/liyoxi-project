import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useState } from "react";

import { ConfigPage } from "../../../components/ConfigPage";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { useCan } from "../../../lib/permissions";
import { DICT_QUERY } from "../../../lib/query";
import { configResult, errorMessage, failureFields, isConflict } from "./api";
import {
  CONFIG_KEY,
  createConfigIntent,
  dictBody,
  dictCanDisable,
  dictDepth,
  dictDraft,
  dictSearch,
  valueText,
  type DictCreateBody,
  type DictDraft,
  type DictItem,
  type DictType,
  type DictUpdateBody,
} from "./model";
import { DraftRejected, ErrorSummary, UnsavedGuard } from "./private-controls";
import "./config.css";

const route = getRouteApi("/sys/dict");
export function DictPage() {
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    search = dictSearch(route.useSearch());
  const canEdit = useCan("sys.dict.edit");
  const [editing, setEditing] = useState<{ type: DictType; item?: DictItem }>();
  const [toggle, setToggle] = useState<{ item: DictItem; enabled: boolean }>();
  const [notice, setNotice] = useState<string>();
  const types = useQuery({
    queryKey: [...CONFIG_KEY, "dict-types"],
    queryFn: async () =>
      (await configResult(await services.api.client.GET("/api/v1/admin/dict-types")))
        .items as unknown as DictType[],
    ...DICT_QUERY,
  });
  const type = types.data?.find((row) => row.typeKey === search.type) ?? types.data?.[0];
  const list = useQuery({
    queryKey: [...CONFIG_KEY, "dict", type?.typeKey],
    enabled: Boolean(type),
    queryFn: async () =>
      (
        await configResult(
          await services.api.client.GET("/api/v1/admin/dict-items", {
            params: {
              query: {
                typeKey: type!.typeKey,
                includeDisabled: "true",
                withRefCount: "true",
              },
            },
          }),
        )
      ).items as unknown as DictItem[],
    ...DICT_QUERY,
  });
  const selected = list.data?.find((row) => row.dictItemId === search.id);
  const visible =
    list.data?.filter(
      (row) =>
        (search.disabled === "true" || row.isEnabled) &&
        (!search.q || `${row.name} ${row.code}`.includes(search.q)),
    ) ?? [];
  const refresh = async () => {
    await Promise.all([types.refetch(), list.refetch()]);
  };
  const change = (patch: Partial<typeof search>, ignoreBlocker = false) =>
    void navigate({
      search: { ...search, ...patch, type: patch.type ?? type?.typeKey },
      ignoreBlocker,
    });
  return (
    <>
      <PageHeader
        title="数据字典"
        subtitle="维护显示名称与合法扩展属性；编码和层级由系统管理。"
        extra={
          canEdit && type?.canCreate ? (
            <Button type="primary" onClick={() => setEditing({ type })}>
              新增字典项
            </Button>
          ) : undefined
        }
      />
      {notice ? <Alert type="warning" title={notice} /> : null}
      <MasterDetailPage
        label="数据字典"
        selectedKey={search.id}
        onSelect={(id) => change({ id })}
        onRetry={() => void refresh()}
        list={({ onSelect }) => (
          <section className="lyx-card lyx-config-list">
            <div className="lyx-config-actions">
              <Select
                aria-label="字典类型"
                style={{ minWidth: 180 }}
                value={type?.typeKey}
                options={types.data?.map((row) => ({
                  value: row.typeKey,
                  label: `${row.name}（${row.itemCount}）`,
                }))}
                onChange={(key: string) => change({ type: key, id: undefined })}
              />
              <Input.Search
                type="search"
                aria-label="搜索字典项"
                placeholder="名称或编码"
                value={search.q ?? ""}
                onChange={(event) => change({ q: event.target.value || undefined })}
              />
              <Checkbox
                checked={search.disabled === "true"}
                onChange={(event) =>
                  change({ disabled: event.target.checked ? "true" : undefined })
                }
              >
                显示停用项
              </Checkbox>
            </div>
            {type ? (
              <p className="lyx-config-help">
                {type.structure === "tree" ? `树形 · 最多 ${type.maxDepth} 级` : "平级"} · 版本{" "}
                {type.versionNo} ·{" "}
                {type.isSystem
                  ? "系统枚举，只可改显示名称和说明"
                  : type.canCreate
                    ? "可新增"
                    : "不可新增"}{" "}
                ·{" "}
                {type.disablePolicy === "never"
                  ? "不可停用"
                  : type.disablePolicy === "block_if_referenced"
                    ? "引用中不可停用"
                    : "可启停"}
              </p>
            ) : null}
            {types.isError || list.isError ? (
              <ErrorState
                message={errorMessage(types.error ?? list.error)}
                onRetry={() => void refresh()}
              />
            ) : list.isPending ? (
              <p aria-busy="true">正在读取字典…</p>
            ) : !visible.length ? (
              <EmptyState title={search.q ? "没有符合条件的字典项" : "暂无字典项"} />
            ) : (
              <ul className="lyx-config-dict-list">
                {visible.map((item) => (
                  <li key={item.dictItemId}>
                    <button
                      className="lyx-focusable lyx-config-dict-item"
                      aria-pressed={item.dictItemId === search.id}
                      style={{ paddingInlineStart: 16 + (dictDepth(item, list.data!) - 1) * 20 }}
                      onClick={() => onSelect(item.dictItemId)}
                    >
                      <span>
                        <strong>{item.name}</strong>
                        <span className="lyx-config-help">{item.code}</span>
                      </span>
                      <span>
                        {item.isEnabled ? "启用" : "停用"} ·{" "}
                        {item.refCount === null ? "引用来源未登记" : `引用 ${item.refCount}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        detailTitle="字典项详情"
        detail={
          search.id
            ? list.isPending
              ? { key: search.id, status: "loading" }
              : list.isError
                ? { key: search.id, status: "error" }
                : selected
                  ? {
                      key: search.id,
                      status: "ready",
                      content: (
                        <>
                          <ReadOnlyValue label="名称" value={selected.name} />
                          <ReadOnlyValue label="编码" value={selected.code} />
                          <ReadOnlyValue label="类型" value={type?.name ?? selected.typeKey} />
                          <ReadOnlyValue label="上级编码" value={selected.parentCode ?? "无"} />
                          <ReadOnlyValue
                            label="状态"
                            value={selected.isEnabled ? "启用" : "停用"}
                          />
                          <ReadOnlyValue
                            label="引用计数"
                            value={
                              selected.refCount === null
                                ? "未注册引用来源，不能视为0"
                                : String(selected.refCount)
                            }
                          />
                          <ReadOnlyValue label="说明" value={selected.description ?? "—"} />
                          <ReadOnlyValue label="扩展属性" value={valueText(selected.ext)} />
                          {canEdit && type ? (
                            <div className="lyx-config-actions">
                              <Button onClick={() => setEditing({ type, item: selected })}>
                                编辑名称与属性
                              </Button>
                              {!type.isSystem &&
                              (!selected.isEnabled || dictCanDisable(type, selected)) ? (
                                <Button
                                  danger={selected.isEnabled}
                                  onClick={() =>
                                    setToggle({ item: selected, enabled: !selected.isEnabled })
                                  }
                                >
                                  {selected.isEnabled ? "停用" : "启用"}
                                </Button>
                              ) : null}
                            </div>
                          ) : (
                            <p>当前字典为只读</p>
                          )}
                        </>
                      ),
                    }
                  : { key: search.id, status: "empty" }
            : undefined
        }
      />
      {editing ? (
        <DictEditor
          key={editing.item?.dictItemId ?? `new:${editing.type.typeKey}`}
          {...editing}
          items={list.data ?? []}
          close={() => setEditing(undefined)}
          save={async (draft, key) => {
            const result = dictBody(editing.type, draft, editing.item);
            if (!result.body) return { errors: result.errors };
            try {
              const saved = editing.item
                ? await configResult(
                    await services.api.client.PATCH("/api/v1/admin/dict-items/{dictItemId}", {
                      params: { path: { dictItemId: editing.item.dictItemId } },
                      body: result.body as DictUpdateBody,
                      headers: { "Idempotency-Key": key },
                    }),
                  )
                : await configResult(
                    await services.api.client.POST("/api/v1/admin/dict-items", {
                      body: result.body as DictCreateBody,
                      headers: { "Idempotency-Key": key },
                    }),
                  );
              await refresh();
              change({ id: saved.dictItemId }, true);
              setEditing(undefined);
              setNotice("字典项已保存并重新读取");
              return {};
            } catch (error) {
              if (isConflict(error)) await refresh();
              return {
                errors: failureFields(error),
                message: isConflict(error)
                  ? "记录已被其他操作人修改。草稿已保留，请关闭后重新核对当前版本。"
                  : errorMessage(error),
              };
            }
          }}
        />
      ) : null}
      {toggle ? (
        <ConfirmAction
          open
          spec={{
            title: toggle.enabled ? "启用字典项" : "停用字典项",
            echo: [
              { label: "字典项", value: toggle.item.name },
              { label: "编码", value: toggle.item.code },
            ],
            checkLabel: "我已核对该字典项与引用影响",
            danger: !toggle.enabled,
          }}
          action="dict-toggle"
          onCancel={() => setToggle(undefined)}
          onDone={() => {
            setToggle(undefined);
            setNotice("状态已更新并重新读取");
          }}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              await configResult(
                await services.api.client.PATCH("/api/v1/admin/dict-items/{dictItemId}", {
                  params: { path: { dictItemId: toggle.item.dictItemId } },
                  body: { lockVersion: toggle.item.lockVersion, isEnabled: toggle.enabled },
                  headers: { "Idempotency-Key": idempotencyKey },
                }),
              );
              await refresh();
              return { outcome: "done" };
            } catch (error) {
              await refresh();
              if (isConflict(error)) {
                setToggle(undefined);
                setNotice("字典项已变化，请核对新版本后重新操作");
              }
              return { outcome: "failed", message: errorMessage(error) };
            }
          }}
        />
      ) : null}
    </>
  );
}
function DictEditor({
  type,
  item,
  items,
  close,
  save,
}: {
  type: DictType;
  item?: DictItem;
  items: readonly DictItem[];
  close: () => void;
  save: (
    draft: DictDraft,
    key: string,
  ) => Promise<{ errors?: Record<string, string>; message?: string }>;
}) {
  const initial = dictDraft(item),
    [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false),
    [intent] = useState(() => createConfigIntent(item ? "dict-update" : "dict-create"));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const cancel = () => {
    if (!dirty || window.confirm("放弃尚未保存的字典更改？")) close();
  };
  return (
    <Modal
      open
      title={item ? "编辑字典项" : "新增字典项"}
      footer={null}
      onCancel={cancel}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      destroyOnHidden
    >
      <UnsavedGuard dirty={dirty} />
      <ConfigPage
        label="字典编辑"
        pending={busy}
        error={message}
        submitLabel="保存字典项"
        onSubmit={async () => {
          setBusy(true);
          try {
            await intent.submit(draft, async (key) => {
              const result = await save(draft, key);
              if (result.message || Object.keys(result.errors ?? {}).length)
                throw new DraftRejected(result.errors ?? {}, result.message);
            });
          } catch (error) {
            setErrors(error instanceof DraftRejected ? error.fields : {});
            setMessage(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ReadOnlyValue label="类型" value={type.name} />
        {item ? (
          <ReadOnlyValue label="编码（不可修改）" value={item.code} />
        ) : (
          <p>编码由系统生成，保存后不可修改。</p>
        )}
        {!item && type.structure === "tree" ? (
          <FormField label="上级项">
            {(props) => (
              <Select
                {...props}
                aria-label="上级项"
                value={draft.parentCode ?? ""}
                style={{ width: "100%" }}
                options={[
                  { value: "", label: "无（顶级）" },
                  ...items
                    .filter((row) => row.isEnabled && dictDepth(row, items) < type.maxDepth)
                    .map((row) => ({ value: row.code, label: row.name })),
                ]}
                onChange={(value: string) => setDraft({ ...draft, parentCode: value || null })}
              />
            )}
          </FormField>
        ) : (
          <ReadOnlyValue label="上级编码（不可修改）" value={draft.parentCode ?? "无"} />
        )}
        <FormField label="名称" maxLength={20} value={draft.name} error={errors.name}>
          {(props) => (
            <Input
              {...props}
              value={draft.name}
              maxLength={20}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="说明" maxLength={40} value={draft.description} error={errors.description}>
          {(props) => (
            <Input
              {...props}
              value={draft.description}
              maxLength={40}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          )}
        </FormField>
        {!type.isSystem ? (
          <>
            <FormField label="标签（逗号或顿号分隔）" error={errors.tags}>
              {(props) => (
                <Input
                  {...props}
                  value={draft.tags}
                  onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                />
              )}
            </FormField>
            <FormField label="扩展属性 JSON" error={errors.ext}>
              {(props) => (
                <Input.TextArea
                  {...props}
                  value={draft.ext}
                  autoSize={{ minRows: 4, maxRows: 12 }}
                  onChange={(event) => setDraft({ ...draft, ext: event.target.value })}
                />
              )}
            </FormField>
          </>
        ) : null}
        <ErrorSummary errors={errors} />
        <Button onClick={cancel}>取消</Button>
      </ConfigPage>
    </Modal>
  );
}
