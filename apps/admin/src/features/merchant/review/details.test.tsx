import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CompareTable } from "./details";

it("独立证照字段和扩展字段均可人工核对，号码保持服务端mask且未知结果保守显示", () => {
  const html = renderToStaticMarkup(
    <CompareTable
      doc={{
        docType: "business_license",
        holderName: "演练主体",
        certNoMask: "91310000****1L",
        principalNameMask: "张**",
        validStartDate: "2020-01-01",
        validEndDate: null,
        isLongTerm: true,
        displayFields: [{ key: "address", label: "住所", value: "演练路" }],
        fieldChecks: [{ code: "one", field: "address", result: "future_check" }],
      }}
    />,
  );
  for (const value of [
    "演练主体",
    "91310000****1L",
    "张**",
    "2020-01-01",
    "长期",
    "演练路",
    "人工核对",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("future_check");
});
