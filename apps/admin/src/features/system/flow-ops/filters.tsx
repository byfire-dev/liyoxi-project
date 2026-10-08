import {
  AGGREGATE_TYPES,
  EVENTS,
  JOBS,
  SUBSCRIBERS,
  TIMERS,
  TIMER_SUBJECT_TYPES,
} from "@liyoxi/contract/registry";
import { Alert, Button, Input, Select } from "antd";
import { useState } from "react";
import { DateRangeField, type DateRangeFieldProps } from "../../../components/DateRangeField";
import { FormField } from "../../../components/FormField";
import { flowTab, statusLabel, type FlowSearch } from "./model";
const timerStates = ["failed", "scheduled", "dispatched", "fired", "skipped", "cancelled"];
const deliveryStates = ["dead", "retry", "pending", "leased", "done"];
const webhookStates = ["failed", "dead", "received", "processed", "ignored"];
const providers = ["wechatpay", "wechat", "wecom", "ci", "asr", "sms", "esign"];
const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
export function FlowFilters({
  search,
  onChange,
}: {
  search: FlowSearch;
  onChange(patch: Record<string, string | undefined>): void;
}) {
  const tab = flowTab(search),
    [draft, setDraft] = useState<Record<string, string | undefined>>(search),
    [notice, setNotice] = useState<string>();
  const [dates, setDates] = useState<DateRangeFieldProps["value"]>(null);
  const set = (key: string, value: string | undefined) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const stateKey = tab === "webhooks" ? "processState" : "status",
    states = tab === "timers" ? timerStates : tab === "outbox" ? deliveryStates : webhookStates;
  const pair = tab === "timers" ? ["subjectType", "subjectId"] : ["aggregateType", "aggregateId"];
  const from = tab === "timers" ? "fireFrom" : "receivedFrom",
    to = tab === "timers" ? "fireTo" : "receivedTo";
  const input = (key: string, label: string) => (
    <FormField key={key} label={label}>
      {(field) => (
        <Input
          {...field}
          value={draft[key] ?? ""}
          maxLength={200}
          onChange={(event) => set(key, event.target.value.trim() || undefined)}
        />
      )}
    </FormField>
  );
  const select = (key: string, label: string, values: readonly string[], multiple = false) => (
    <FormField key={key} label={label}>
      {(field) => (
        <Select
          {...field}
          allowClear
          mode={multiple ? "multiple" : undefined}
          value={multiple ? (draft[key]?.split(",") ?? []) : draft[key]}
          options={options(values)}
          showSearch
          optionFilterProp="label"
          onChange={(value: string | string[] | undefined) =>
            set(key, Array.isArray(value) ? value.join(",") || undefined : value)
          }
        />
      )}
    </FormField>
  );
  return (
    <form
      className="lyx-flow-filters"
      aria-label="流程运维筛选"
      onSubmit={(event) => {
        event.preventDefault();
        if (tab !== "webhooks" && Boolean(draft[pair[0]!]) !== Boolean(draft[pair[1]!])) {
          setNotice("对象类型与对象 ID 必须同时填写");
          return;
        }
        if (draft[from] && draft[to] && draft[from]! > draft[to]!) {
          setNotice("开始日期不能晚于结束日期");
          return;
        }
        setNotice(undefined);
        onChange(draft);
      }}
    >
      <div className="lyx-flow-filters__grid">
        <FormField label="传输状态">
          {(field) => (
            <Select
              {...field}
              allowClear
              mode="multiple"
              value={draft[stateKey]?.split(",") ?? []}
              options={states.map((value) => ({ value, label: statusLabel(value) }))}
              onChange={(value: string[]) => set(stateKey, value.join(",") || undefined)}
            />
          )}
        </FormField>
        {tab === "timers" ? (
          <>
            {select(
              "kind",
              "定时器规则",
              [...new Set([...TIMERS.map((row) => row.kind), ...JOBS.map((row) => row.kind)])],
              true,
            )}
            {select("subjectType", "对象类型", TIMER_SUBJECT_TYPES)}
            {input("subjectId", "对象 ID")}
            {input("entityId", "主体 ID")}
          </>
        ) : null}
        {tab === "outbox" ? (
          <>
            {select(
              "subscriber",
              "订阅者",
              SUBSCRIBERS.map((row) => row.name),
            )}
            {select(
              "eventType",
              "事件类型",
              EVENTS.map((row) => row.name),
            )}
            {select("aggregateType", "对象类型", AGGREGATE_TYPES)}
            {input("aggregateId", "对象 ID")}
            {input("entityId", "主体 ID")}
          </>
        ) : null}
        {tab === "webhooks" ? (
          <>
            {select("provider", "来源", providers, true)}
            {input("eventType", "事件类型")}
          </>
        ) : null}
      </div>
      <div className="lyx-flow-filters__footer">
        {tab !== "outbox" ? (
          <>
            <span>{tab === "timers" ? "到期日期" : "收件日期"}</span>
            <DateRangeField
              aria-label="流程运维日期范围"
              format="YYYY-MM-DD"
              placeholder={[search[from] ?? "开始日期", search[to] ?? "结束日期"]}
              value={dates}
              onChange={(value, text) => {
                setDates(value);
                set(from, text[0] || undefined);
                set(to, text[1] || undefined);
              }}
            />
          </>
        ) : null}
        <Button htmlType="submit" type="primary">
          查询
        </Button>
        <Button
          onClick={() => {
            setDraft({ tab });
            setDates(null);
            setNotice(undefined);
            onChange({
              tab,
              status: undefined,
              processState: undefined,
              kind: undefined,
              subjectType: undefined,
              subjectId: undefined,
              entityId: undefined,
              subscriber: undefined,
              eventType: undefined,
              aggregateType: undefined,
              aggregateId: undefined,
              provider: undefined,
              fireFrom: undefined,
              fireTo: undefined,
              receivedFrom: undefined,
              receivedTo: undefined,
            });
          }}
        >
          重置筛选
        </Button>
      </div>
      {notice ? <Alert type="warning" title={notice} /> : null}
    </form>
  );
}
