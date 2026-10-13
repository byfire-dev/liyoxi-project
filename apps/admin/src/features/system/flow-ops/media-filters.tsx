import {
  MEDIA_JOB_KIND,
  MEDIA_JOB_PARENT_TYPE,
  MEDIA_JOB_STATE,
  MEDIA_JOB_SUBJECT_TYPE,
} from "@liyoxi/contract/enums";
import { Alert, Button, Input, Select } from "antd";
import { useState } from "react";
import { DateRangeField, type DateRangeFieldProps } from "../../../components/DateRangeField";
import { FormField } from "../../../components/FormField";
import { MEDIA_FILTER_KEYS, mediaStateLabel } from "./media-model";
export function MediaFilters({
  search,
  onChange,
}: {
  search: Record<string, string>;
  onChange(patch: Record<string, string | undefined>): void;
}) {
  const [draft, setDraft] = useState<Record<string, string | undefined>>(search),
    [notice, setNotice] = useState<string>(),
    [dates, setDates] = useState<DateRangeFieldProps["value"]>(null);
  const set = (key: string, value: string | undefined) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const select = (key: string, label: string, values: readonly string[], multiple = false) => (
    <FormField key={key} label={label}>
      {(field) => (
        <Select
          {...field}
          allowClear
          mode={multiple ? "multiple" : undefined}
          value={multiple ? (draft[key]?.split(",") ?? []) : draft[key]}
          options={values.map((value) => ({
            value,
            label: key === "state" ? mediaStateLabel(value) : value,
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
          maxLength={64}
          onChange={(event) => set(key, event.target.value.trim() || undefined)}
        />
      )}
    </FormField>
  );
  return (
    <form
      className="lyx-flow-filters"
      aria-label="媒体任务筛选"
      onSubmit={(event) => {
        event.preventDefault();
        for (const [type, id] of [
          ["subjectType", "subjectId"],
          ["parentType", "parentId"],
          ["createdFrom", "createdTo"],
        ] as const)
          if (Boolean(draft[type]) !== Boolean(draft[id])) {
            setNotice(
              type === "createdFrom" ? "日期范围必须同时填写" : "对象类型与 ID 必须同时填写",
            );
            return;
          }
        if (draft.createdFrom && draft.createdTo && draft.createdFrom > draft.createdTo) {
          setNotice("开始日期不能晚于结束日期");
          return;
        }
        setNotice(undefined);
        onChange(draft);
      }}
    >
      <div className="lyx-flow-filters__grid">
        {select("state", "任务状态", MEDIA_JOB_STATE.values, true)}
        {select("kind", "任务种类", MEDIA_JOB_KIND.values, true)}
        {select("subjectType", "对象类型", MEDIA_JOB_SUBJECT_TYPE.values)}
        {input("subjectId", "对象 ID")}
        {select("parentType", "父对象类型", MEDIA_JOB_PARENT_TYPE.values)}
        {input("parentId", "父对象 ID")}
        {select("sort", "排序", ["-finishedAt", "-createdAt"])}
      </div>
      <div className="lyx-flow-filters__footer">
        <span>创建日期</span>
        <DateRangeField
          aria-label="媒体任务创建日期范围"
          format="YYYY-MM-DD"
          placeholder={[search.createdFrom ?? "开始日期", search.createdTo ?? "结束日期"]}
          value={dates}
          onChange={(value, text) => {
            setDates(value);
            set("createdFrom", text[0] || undefined);
            set("createdTo", text[1] || undefined);
          }}
        />
        <Button type="primary" htmlType="submit">
          查询
        </Button>
        <Button
          type="link"
          onClick={() =>
            onChange(
              Object.fromEntries(
                MEDIA_FILTER_KEYS.filter((key) => !["page", "pageSize"].includes(key)).map(
                  (key) => [key, undefined],
                ),
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
