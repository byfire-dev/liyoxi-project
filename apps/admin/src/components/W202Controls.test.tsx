import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CapsuleRadio } from "./CapsuleRadio";
import { DiffBlock } from "./DiffBlock";
import { LogList } from "./LogList";
import { NeutralNotice } from "./NeutralNotice";
import { RadioCard } from "./RadioCard";
import { ReadOnlyValue } from "./ReadOnlyValue";
import { ReasonChips } from "./ReasonChips";
import { Stepper } from "./Stepper";

const options = [
  { value: "first", label: "第一项" },
  { value: "second", label: "第二项", disabled: true },
];

describe("叶构件的语义边界", () => {
  it("并排单选组有各自原生名称，保持受控选择和禁用选项", () => {
    const markup = renderToStaticMarkup(
      <>
        <CapsuleRadio ariaLabel="类别" options={options} value="first" onChange={() => {}} />
        <ReasonChips ariaLabel="原因" options={options} value="first" onChange={() => {}} />
        <RadioCard ariaLabel="人员" options={options} value="first" onChange={() => {}} disabled />
      </>,
    );
    const groupNames = [...markup.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(groupNames).size).toBe(3);
    expect(markup.match(/type="radio"/g)).toHaveLength(6);
    expect(markup.match(/checked=""/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="原因"');
    expect(markup).toContain('<fieldset class="lyx-radio-cards" aria-label="人员" disabled="">');
    const disabledOptions = markup
      .match(/<input\b[^>]*>/g)
      ?.filter((input) => input.includes('value="second"'));
    expect(disabledOptions).toHaveLength(3);
    expect(disabledOptions?.every((input) => input.includes('disabled=""'))).toBe(true);
  });

  it("人员卡分开提供名称与辅助信息关联", () => {
    const markup = renderToStaticMarkup(
      <RadioCard
        ariaLabel="分配人员"
        value="staff-a"
        options={[{ value: "staff-a", label: "员工甲", description: "制作组", meta: "当前 3 件" }]}
        onChange={() => {}}
      />,
    );
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]?.split(" ");
    expect(labelledBy).toBeTruthy();
    expect(markup).toContain(`id="${labelledBy}">员工甲`);
    expect(describedBy).toHaveLength(2);
    for (const id of describedBy ?? []) expect(markup).toContain(`id="${id}"`);
  });

  it("只读展示保留原因，不提供可编辑输入；动态中性说明采用礼貌播报", () => {
    const readOnly = renderToStaticMarkup(
      <ReadOnlyValue label="编号" value="LX-001" reason="编号由系统分配" />,
    );
    expect(readOnly).toContain('role="group" aria-label="编号"');
    expect(readOnly).toContain("编号由系统分配");
    expect(readOnly).not.toMatch(/<(input|textarea|button)\b/);
    expect(renderToStaticMarkup(<NeutralNotice>静态说明</NeutralNotice>)).not.toContain(
      'role="status"',
    );
    expect(renderToStaticMarkup(<NeutralNotice live>更新说明</NeutralNotice>)).toContain(
      'role="status"',
    );
  });

  it("步骤以调用方事实播报三态，不假设所有前置步骤已完成", () => {
    const markup = renderToStaticMarkup(
      <Stepper
        ariaLabel="进度"
        steps={[
          { key: "first", label: "第一步", status: "upcoming" },
          { key: "second", label: "第二步", status: "current" },
          { key: "third", label: "第三步", status: "completed" },
        ]}
      />,
    );
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain("未到达");
    expect(markup).toContain("进行中");
    expect(markup).toContain("已完成");
    expect(markup).toContain("lyx-stepper__item--upcoming");
  });

  it("日志带三列标题、调用方时间和具名空态；前后内容分别有标题", () => {
    const logs = renderToStaticMarkup(
      <LogList
        ariaLabel="操作记录"
        entries={[
          {
            key: "one",
            time: "10:00",
            dateTime: "2026-10-07T02:00:00Z",
            actor: "员工甲",
            content: "已保存",
          },
        ]}
      />,
    );
    expect(logs).toContain('<th scope="col">时间</th>');
    expect(logs).toContain('<th scope="col">操作人</th>');
    expect(logs).toContain('<time dateTime="2026-10-07T02:00:00Z">10:00</time>');
    expect(
      renderToStaticMarkup(<LogList ariaLabel="操作记录" entries={[]} empty="尚无变更" />),
    ).toContain("尚无变更");
    const diff = renderToStaticMarkup(
      <DiffBlock ariaLabel="资料变更" before="旧值" after="新值" />,
    );
    expect(diff).toContain('aria-label="资料变更"');
    expect(diff).toContain("变更前");
    expect(diff).toContain("变更后");
    expect(diff.match(/aria-labelledby=/g)).toHaveLength(2);
  });
});
