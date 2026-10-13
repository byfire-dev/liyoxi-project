import {
  FILE_OBJECT_CATEGORY,
  FILE_OBJECT_SCOPE_TYPE,
  FILE_OBJECT_STATUS,
  FILE_PURGE_RUN_STATE,
  MEDIA_ACTOR_TYPE,
} from "@liyoxi/contract/enums";
import { Alert, Button, Input, Select } from "antd";
import { useState } from "react";
import { DateRangeField, type DateRangeFieldProps } from "../../../components/DateRangeField";
import { FormField } from "../../../components/FormField";
import { fileLabels, runLabels, textLabel, type PurgeSearch } from "./model";
export function PurgeFilters({
  search,
  kind,
  onChange,
}: {
  search: PurgeSearch;
  kind: "runs" | "files";
  onChange(patch: Record<string, string | undefined>): void;
}) {
  const [draft, setDraft] = useState<Record<string, string | undefined>>(search),
    [notice, setNotice] = useState<string>();
  const [dates, setDates] = useState<DateRangeFieldProps["value"]>(null);
  const set = (key: string, value: string | undefined) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const select = (
    key: string,
    label: string,
    values: readonly string[],
    multiple = false,
    labels?: Readonly<Record<string, string>>,
  ) => (
    <FormField key={key} label={label}>
      {(field) => (
        <Select
          {...field}
          allowClear
          mode={multiple ? "multiple" : undefined}
          value={multiple ? (draft[key]?.split(",") ?? []) : draft[key]}
          options={values.map((value) => ({
            value,
            label: labels ? textLabel(labels, value) : value,
          }))}
          onChange={(value: string | string[] | undefined) =>
            set(key, Array.isArray(value) ? value.join(",") || undefined : value)
          }
        />
      )}
    </FormField>
  );
  const input = (key: string, label: string) => (
    <FormField key={key} label={label}>
      {(field) => (
        <Input
          {...field}
          value={draft[key] ?? ""}
          maxLength={200}
          onChange={(event) => set(key, event.target.value || undefined)}
        />
      )}
    </FormField>
  );
  return (
    <form
      className="lyx-purge-filters"
      aria-label={kind === "runs" ? "清除运行筛选" : "文件筛选"}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.deletedFrom && draft.deletedTo && draft.deletedFrom > draft.deletedTo) {
          setNotice("开始日期不能晚于结束日期");
          return;
        }
        onChange(draft);
      }}
    >
      <div className="lyx-purge-filters__grid">
        {kind === "runs" ? (
          select("state", "运行状态", FILE_PURGE_RUN_STATE.values, true, runLabels)
        ) : (
          <>
            {select("status", "文件状态", FILE_OBJECT_STATUS.values, true, fileLabels)}
            {select("category", "文件分类", FILE_OBJECT_CATEGORY.values, true)}
            {input("q", "文件名包含")}
            {select("scopeType", "归属类型", FILE_OBJECT_SCOPE_TYPE.values)}
            {input("entityId", "主体 ID")}
            {input("storeId", "门店 ID")}
            {select("uploadActorType", "上传人类型", MEDIA_ACTOR_TYPE.values)}
            {input("uploadActorId", "上传人 ID")}
            {input("fileIds", "文件 ID（逗号分隔）")}
            {search.tab === "files" ? input("purgeRunId", "运行 ID") : null}
            {select("sort", "排序", ["-deletedAt", "-createdAt", "-sizeBytes"])}
          </>
        )}
      </div>
      <div className="lyx-purge-filters__footer">
        {kind === "files" ? (
          <>
            <span>清除日期</span>
            <DateRangeField
              aria-label="文件清除日期范围"
              format="YYYY-MM-DD"
              placeholder={[search.deletedFrom ?? "开始日期", search.deletedTo ?? "结束日期"]}
              value={dates}
              onChange={(value, text) => {
                setDates(value);
                set("deletedFrom", text[0] || undefined);
                set("deletedTo", text[1] || undefined);
              }}
            />
          </>
        ) : null}
        <Button type="primary" htmlType="submit">
          查询
        </Button>
        <Button
          type="link"
          onClick={() =>
            onChange(
              Object.fromEntries(
                (kind === "runs"
                  ? ["state"]
                  : [
                      "status",
                      "category",
                      "scopeType",
                      "entityId",
                      "storeId",
                      "uploadActorType",
                      "uploadActorId",
                      "fileIds",
                      "q",
                      "deletedFrom",
                      "deletedTo",
                      "sort",
                      ...(search.tab === "files" ? ["purgeRunId"] : []),
                    ]
                ).map((key) => [key, undefined]),
              ),
            )
          }
        >
          重置筛选
        </Button>
      </div>
      {notice ? <Alert type="warning" title={notice} /> : null}
    </form>
  );
}
