import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Modal } from "antd";
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
import { configResult, errorMessage, failureFields, isConflict } from "./api";
import {
  CONFIG_KEY,
  configTableSearch,
  flagBody,
  jsonText,
  valueText,
  type Flag,
  type FlagBody,
  type Json,
} from "./model";
import { ErrorSummary, JsonField, UnsavedGuard } from "./private-controls";
import "./config.css";

const route = getRouteApi("/sys/flags");
export function FlagsPage() {
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    raw = route.useSearch(),
    search = configTableSearch(raw);
  const canEdit = useCan("sys.super_admin");
  const [notice, setNotice] = useState<string>();
  const list = useQuery({
    queryKey: [...CONFIG_KEY, "flags"],
    queryFn: async () =>
      (await configResult(await services.api.client.GET("/api/v1/admin/feature-flags")))
        .items as unknown as Flag[],
    ...DICT_QUERY,
  });
  const editing = list.data?.find((flag) => flag.flagKey === raw.id);
  const filtered =
    list.data?.filter(
      (flag) => !search.q || `${flag.flagKey} ${flag.description}`.includes(search.q),
    ) ?? [];
  const query: QueryState<Flag> = list.isPending
    ? { status: "loading" }
    : list.isError
      ? { status: "error", message: errorMessage(list.error) }
      : {
          status: "success",
          items: filtered.slice((search.page - 1) * search.pageSize, search.page * search.pageSize),
          total: filtered.length,
        };
  const columns: QueryColumn<Flag>[] = [
    {
      key: "key",
      title: "开关键 / 说明",
      render: (flag) => (
        <div className="lyx-cell-2">
          <span className="lyx-cell-2__main">{flag.flagKey}</span>
          <span className="lyx-cell-2__sub">{flag.description ?? "—"}</span>
        </div>
      ),
    },
    {
      key: "default",
      title: "缺省分支",
      width: 180,
      render: (flag) => valueText(flag.defaultValue),
    },
    {
      key: "rules",
      title: "规则 / 类型",
      width: 150,
      render: (flag) => `${flag.rules.length} 条有序规则 · ${flag.valueType}`,
    },
    { key: "version", title: "版本", width: 70, render: (flag) => flag.lockVersion },
    {
      key: "actions",
      title: "操作",
      width: 100,
      render: (flag) => (
        <Button
          type="link"
          onClick={() => {
            void navigate({ search: { ...writeTableSearch(search), id: flag.flagKey } });
          }}
        >
          查看与编辑
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="开关管理"
        subtitle="只限超级管理员。按已有顺序命中首条规则，否则使用缺省分支。"
      />
      {notice ? <Alert type="success" title={notice} /> : null}
      <QueryTablePage
        label="开关管理"
        search={search}
        onSearchChange={(next) =>
          void navigate({ search: writeTableSearch(configTableSearch(writeTableSearch(next))) })
        }
        keywordPlaceholder="搜索开关键或说明"
        columns={columns}
        rowKey={(flag) => flag.flagKey}
        query={query}
        onRetry={() => void list.refetch()}
        empty={{ title: "暂无特性开关" }}
      />
      {editing ? (
        <FlagEditor
          key={editing.flagKey}
          flag={editing}
          canEdit={canEdit}
          close={() => {
            void navigate({ search: writeTableSearch(search), ignoreBlocker: true });
          }}
          save={async (body, key) => {
            try {
              await configResult(
                await services.api.client.PATCH("/api/v1/admin/feature-flags/{flagKey}", {
                  params: { path: { flagKey: editing.flagKey } },
                  body,
                  headers: { "Idempotency-Key": key },
                }),
              );
              await list.refetch();
              void navigate({ search: writeTableSearch(search), ignoreBlocker: true });
              setNotice("开关已保存并重新读取；告警到达情况由运维链路确认");
              return { outcome: "done" };
            } catch (error) {
              if (isConflict(error)) await list.refetch();
              return {
                outcome: "failed",
                message: isConflict(error)
                  ? "开关版本已变化，草稿保留。请关闭后打开新版本并重新核对。"
                  : errorMessage(error),
                fields: failureFields(error),
              };
            }
          }}
        />
      ) : null}
    </>
  );
}
function FlagEditor({
  flag: initialFlag,
  canEdit,
  close,
  save,
}: {
  flag: Flag;
  canEdit: boolean;
  close: () => void;
  save: (
    body: FlagBody,
    key: string,
  ) => Promise<
    { outcome: "done" } | { outcome: "failed"; message: string; fields: Record<string, string> }
  >;
}) {
  const [flag] = useState(initialFlag);
  const [value, setValue] = useState(flag.defaultValue as Json),
    [rules, setRules] = useState(jsonText(flag.rules)),
    [description, setDescription] = useState(flag.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [jsonIssue, setJsonIssue] = useState<string>();
  const [confirm, setConfirm] = useState<FlagBody>();
  const dirty =
    jsonText(value) !== jsonText(flag.defaultValue) ||
    rules !== jsonText(flag.rules) ||
    description !== (flag.description ?? "");
  const cancel = () => {
    if (!dirty || window.confirm("放弃尚未保存的开关更改？")) close();
  };
  return (
    <Modal
      open
      title={`开关 ${flag.flagKey}`}
      width={760}
      footer={null}
      onCancel={cancel}
      closable={!confirm}
      keyboard={!confirm}
      mask={{ closable: !confirm }}
      destroyOnHidden
    >
      <UnsavedGuard dirty={dirty} />
      <ConfigPage
        label="开关编辑"
        readOnly={!canEdit}
        pending={Boolean(confirm)}
        canSubmit={dirty && !jsonIssue}
        onSubmit={() => {
          const result = flagBody(flag, value, rules, description);
          setErrors(result.errors);
          if (result.body) setConfirm(result.body);
        }}
      >
        <ReadOnlyValue
          label="规则语义"
          value="按数组顺序匹配；每条已填写条件全部满足才命中。未命中任何规则时采用缺省分支。"
        />
        <ReadOnlyValue label="值类型 / 版本" value={`${flag.valueType} / ${flag.lockVersion}`} />
        <ReadOnlyValue label="公开范围" value={flag.exposedTo === "client" ? "客户端" : "服务端"} />
        {flag.valueType === "json" ? (
          <JsonField
            label="缺省值 JSON"
            value={value}
            onChange={setValue}
            onIssue={setJsonIssue}
            error={errors.defaultValue}
          />
        ) : (
          <FormField label="缺省值" error={errors.defaultValue}>
            {(props) =>
              flag.valueType === "bool" ? (
                <Checkbox
                  id={props.id}
                  checked={value === true}
                  onChange={(event) => setValue(event.target.checked)}
                >
                  默认开启
                </Checkbox>
              ) : (
                <Input
                  {...props}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => setValue(event.target.value)}
                />
              )
            }
          </FormField>
        )}
        <FormField label="有序规则 JSON" error={errors.rules}>
          {(props) => (
            <Input.TextArea
              {...props}
              value={rules}
              autoSize={{ minRows: 7, maxRows: 15 }}
              onChange={(event) => setRules(event.target.value)}
            />
          )}
        </FormField>
        <p className="lyx-config-help">
          条件维度：platform、clientVersion、envVersion、entityIds。支持现有合法条件；不生成求值预览。
        </p>
        {flag.rules.map((rule, index) => (
          <ReadOnlyValue
            key={index}
            label={`当前规则 ${index + 1}`}
            value={<pre className="lyx-config-rule">{jsonText(rule)}</pre>}
          />
        ))}
        <FormField label="说明" error={errors.description}>
          {(props) => (
            <Input
              {...props}
              value={description}
              maxLength={100}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>
        <ErrorSummary errors={errors} />
        <Button onClick={cancel}>关闭</Button>
      </ConfigPage>
      {confirm ? (
        <ConfirmAction
          open
          action="flag-update"
          spec={{
            title: "确认修改开关",
            echo: [
              { label: "开关", value: flag.flagKey },
              { label: "版本", value: String(flag.lockVersion) },
              { label: "缺省值", value: valueText(value) },
            ],
            checkLabel: "我已核对规则顺序、缺省分支与影响范围",
          }}
          onCancel={() => setConfirm(undefined)}
          onDone={close}
          onConfirm={async ({ idempotencyKey }) => {
            const result = await save(confirm, idempotencyKey);
            if (result.outcome === "failed") setErrors(result.fields);
            return result;
          }}
        />
      ) : null}
    </Modal>
  );
}
