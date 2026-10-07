import { Button, Input, Space } from "antd";
import { useRef, useState } from "react";

import { ConfigPage } from "../components/ConfigPage";
import { DateRangeField, type DateRangeFieldProps } from "../components/DateRangeField";
import { FormField } from "../components/FormField";
import { PageHeader } from "../components/PageHeader";
import { DEV_FIXTURE_MARK } from "./mark";

export function ConfigSample() {
  const [name, setName] = useState("样例配置");
  const [readOnly, setReadOnly] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const [submissions, setSubmissions] = useState(0);
  const [dates, setDates] = useState<DateRangeFieldProps["value"]>(null);
  const [dateText, setDateText] = useState("未选择日期");
  const finish = useRef<(() => void) | undefined>(undefined);
  return (
    <div data-fixture={DEV_FIXTURE_MARK} style={{ display: "contents" }}>
      <PageHeader
        title="配置页样例"
        subtitle="字段与提交由调用方控制；只读和提交中阻止编辑与重复提交。数据为夹具。"
      />
      <Space wrap>
        <Button disabled={pending} onClick={() => setReadOnly((value) => !value)}>
          切换只读
        </Button>
        <Button disabled={pending} onClick={() => setFailure((value) => !value)}>
          {failure ? "恢复正常提交" : "模拟提交失败"}
        </Button>
        <Button
          disabled={!pending}
          onClick={() => {
            setPending(false);
            finish.current?.();
            finish.current = undefined;
          }}
        >
          完成提交
        </Button>
        <span role="status">提交次数：{submissions}</span>
      </Space>
      <ConfigPage
        label="样例配置表单"
        readOnly={readOnly}
        pending={pending}
        canSubmit={name.trim().length > 0}
        aside={
          <>
            <h2>配置说明</h2>
            <p>先修改名称，再保存。等待时可用上方“完成提交”结束样例请求。</p>
            <p>日期范围仅作已有控件键盘回归。</p>
          </>
        }
        onSubmit={() => {
          setSubmissions((count) => count + 1);
          if (failure) return Promise.reject(new Error("sample_failure"));
          setPending(true);
          return new Promise<void>((resolve) => {
            finish.current = resolve;
          });
        }}
      >
        <FormField label="名称">
          {(props) => (
            <Input {...props} value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </FormField>
        <FormField label="日期范围（选填）">
          {(props) => (
            <DateRangeField
              {...props}
              value={dates}
              onChange={(value, text) => {
                setDates(value);
                setDateText(value ? `${text[0]} 至 ${text[1]}` : "未选择日期");
              }}
            />
          )}
        </FormField>
        <span aria-label="已选日期范围">{dateText}</span>
        <FormField label="备注（选填）">
          {(props) => <Input.TextArea {...props} rows={3} placeholder="补充说明" />}
        </FormField>
      </ConfigPage>
    </div>
  );
}
