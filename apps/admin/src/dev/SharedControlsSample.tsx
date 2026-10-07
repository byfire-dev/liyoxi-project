import { Button, Checkbox, Space } from "antd";
import { useState } from "react";

import { CapsuleRadio } from "../components/CapsuleRadio";
import { CompareTable } from "../components/CompareTable";
import { DiffBlock } from "../components/DiffBlock";
import { EmphasisBlock } from "../components/EmphasisBlock";
import { LogList } from "../components/LogList";
import { MonthSwitcher } from "../components/MonthSwitcher";
import { NeutralNotice } from "../components/NeutralNotice";
import { PageHeader } from "../components/PageHeader";
import { RadioCard } from "../components/RadioCard";
import { ReadOnlyValue } from "../components/ReadOnlyValue";
import { ReasonChips } from "../components/ReasonChips";
import { RejectDialog } from "../components/RejectDialog";
import { Stepper } from "../components/Stepper";
import { DEV_FIXTURE_MARK } from "./mark";

const OPTIONS = [
  { value: "a", label: "甲组" },
  { value: "b", label: "乙组" },
  { value: "c", label: "未开放", disabled: true },
];
const REASONS = [
  { value: "missing", label: "资料缺失" },
  { value: "blurred", label: "图片模糊" },
];
const STEPS = [
  { key: "one", label: "已接收", status: "completed" },
  { key: "two", label: "处理中", status: "current" },
  { key: "three", label: "待完成", status: "upcoming" },
] as const;

export function SharedControlsSample() {
  const [capsule, setCapsule] = useState("a");
  const [reason, setReason] = useState("missing");
  const [card, setCard] = useState("a");
  const [month, setMonth] = useState({ year: 2026, month: 12 });
  const [disabled, setDisabled] = useState(false);
  const [modal, setModal] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div data-fixture={DEV_FIXTURE_MARK} style={{ display: "contents" }}>
      <PageHeader title="共用控件样例" subtitle="受控选择与展示；固定夹具，不提交业务数据。" />
      <Checkbox checked={disabled} onChange={(event) => setDisabled(event.target.checked)}>
        禁用选择控件
      </Checkbox>
      <section className="lyx-card lyx-w202-side">
        <h2>胶囊单选</h2>
        <CapsuleRadio
          ariaLabel="区域胶囊"
          value={capsule}
          options={OPTIONS}
          onChange={setCapsule}
          disabled={disabled}
        />
        <h2>原因单选</h2>
        <ReasonChips
          ariaLabel="驳回原因样例"
          value={reason}
          options={REASONS}
          onChange={setReason}
          disabled={disabled}
        />
        <h2>单选卡</h2>
        <RadioCard
          ariaLabel="成员单选卡"
          value={card}
          options={OPTIONS.map((item) => ({
            ...item,
            description: item.value === "a" ? "当前可接收" : "候选成员",
            avatar: item.label.slice(0, 1),
            meta: "样例分组",
          }))}
          onChange={setCard}
          disabled={disabled}
        />
        <h2>月份切换</h2>
        <MonthSwitcher ariaLabel="演练月份" value={month} onChange={setMonth} disabled={disabled} />
      </section>
      <section className="lyx-card lyx-w202-side">
        <h2>只读与提示</h2>
        <ReadOnlyValue label="已脱敏手机号" value="138****0001" reason="按服务端脱敏字段展示" />
        <NeutralNotice>这里是中性说明，由调用方给出内容。</NeutralNotice>
        <EmphasisBlock title="操作前请核对">
          请核对记录版本与当前选择。此处只呈现调用方说明。
        </EmphasisBlock>
      </section>
      <section className="lyx-card lyx-w202-side">
        <h2>步骤进度</h2>
        <Stepper ariaLabel="样例处理进度" steps={STEPS} />
        <h2>三列日志行</h2>
        <LogList
          ariaLabel="样例操作日志"
          entries={[
            {
              key: "a",
              time: "10-07 10:12",
              dateTime: "2026-10-07T02:12:00Z",
              actor: "周航",
              content: "已接收样例记录。",
            },
            {
              key: "b",
              time: "10-07 10:20",
              actor: "林可",
              content:
                "补充长说明：内容超过一行时在内容列内换行，不挤压时间与操作人；本例用于三列布局和读屏顺序验收。",
            },
          ]}
        />
        <h2>变更前后</h2>
        <DiffBlock ariaLabel="样例变更前后" before="原名称：成都组" after="新名称：成都一区组" />
      </section>
      <section className="lyx-card lyx-w202-side">
        <h2>已有比对与驳回</h2>
        <CompareTable
          ariaLabel="已脱敏比对样例"
          rows={[{ key: "phone", label: "手机号", value: "138****0001", result: "一致" }]}
        />
        <Space>
          <Button onClick={() => setModal(true)}>打开通用驳回样例</Button>
        </Space>
      </section>
      {modal ? (
        <RejectDialog
          title="通用驳回样例"
          context="本次仅演示待提交守卫"
          reasons={REASONS}
          reason={reason}
          note={note}
          noteMaxLength={200}
          notePlaceholder="说明需要补正的地方"
          onReasonChange={setReason}
          onNoteChange={setNote}
          pending={pending}
          canSubmit={Boolean(reason && note.trim())}
          onCancel={() => setModal(false)}
          onSubmit={() => setPending(true)}
        >
          <Button
            disabled={!pending}
            onClick={() => {
              setPending(false);
              setModal(false);
            }}
          >
            完成样例提交
          </Button>
        </RejectDialog>
      ) : null}
    </div>
  );
}
