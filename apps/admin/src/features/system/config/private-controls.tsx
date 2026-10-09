import { useBlocker } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select } from "antd";
import { useState } from "react";

import { FormField } from "../../../components/FormField";
import { parseJson, jsonText, type Json, type Param } from "./model";

export class DraftRejected extends Error {
  constructor(
    readonly fields: Record<string, string>,
    message = "请核对表单内容",
  ) {
    super(message);
  }
}

/** 只消费已有 Router 的导航保护，不添加全局事件或改变公共骨架。 */
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  return (
    <Modal
      open={blocker.status === "blocked"}
      title="离开未保存的配置？"
      footer={null}
      onCancel={() => blocker.reset?.()}
      destroyOnHidden
    >
      <p>本页的更改尚未保存。</p>
      <div className="lyx-config-actions">
        <Button onClick={() => blocker.reset?.()}>继续编辑</Button>
        <Button danger onClick={() => blocker.proceed?.()}>
          放弃更改并离开
        </Button>
      </div>
    </Modal>
  );
}
export function JsonField({
  label,
  value,
  onChange,
  error,
  disabled,
  onIssue,
}: {
  label: string;
  value: Json;
  onChange: (value: Json) => void;
  error?: string;
  disabled?: boolean;
  onIssue?: (issue?: string) => void;
}) {
  const [draft, setDraft] = useState(jsonText(value));
  const [issue, setIssue] = useState<string>();
  return (
    <FormField label={label} error={issue ?? error}>
      {(props) => (
        <Input.TextArea
          {...props}
          value={draft}
          disabled={disabled}
          autoSize={{ minRows: 3, maxRows: 10 }}
          onChange={(event) => {
            setDraft(event.target.value);
            const result = parseJson(event.target.value);
            setIssue(result.error);
            onIssue?.(result.error);
            if (!result.error && result.value !== undefined) onChange(result.value);
          }}
        />
      )}
    </FormField>
  );
}
export function TypedParamField({
  item,
  value,
  onChange,
  error,
  onJsonIssue,
}: {
  item: Param;
  value: Json;
  onChange: (value: Json) => void;
  error?: string;
  onJsonIssue?: (issue?: string) => void;
}) {
  const label = item.label;
  if (["json", "int_list", "sla_policy"].includes(item.type))
    return (
      <JsonField
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        onIssue={onJsonIssue}
      />
    );
  return (
    <FormField label={`${label}${item.unit ? `（${item.unit}）` : ""}`} error={error}>
      {(props) =>
        item.type === "bool" ? (
          <Checkbox
            id={props.id}
            aria-describedby={props["aria-describedby"]}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          >
            {label}
          </Checkbox>
        ) : item.type === "int" || item.type === "bp" ? (
          <InputNumber
            {...props}
            style={{ width: "100%" }}
            value={typeof value === "number" ? value : null}
            precision={0}
            min={typeof item.range?.min === "number" ? item.range.min : undefined}
            max={typeof item.range?.max === "number" ? item.range.max : undefined}
            onChange={(next) => onChange(next ?? null)}
          />
        ) : item.type === "enum" ? (
          <Select
            {...props}
            aria-label={label}
            style={{ width: "100%" }}
            value={typeof value === "string" ? value : undefined}
            options={(Array.isArray(item.range?.options) ? item.range.options : [])
              .filter((v): v is string => typeof v === "string")
              .map((v) => ({ value: v, label: v }))}
            onChange={(next: string) => onChange(next)}
          />
        ) : (
          <Input
            {...props}
            type={item.type === "time_hm" ? "time" : "text"}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </FormField>
  );
}
export function ErrorSummary({ errors }: { errors: Record<string, string> }) {
  return Object.keys(errors).length ? (
    <Alert
      type="error"
      title={Object.entries(errors)
        .map(([path, message]) => `${path}：${message}`)
        .join("；")}
    />
  ) : null;
}
