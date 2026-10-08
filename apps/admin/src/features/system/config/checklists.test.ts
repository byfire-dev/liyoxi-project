import { describe, expect, it } from "vitest";
import { CHECKLIST_CODES, checklistBody, configTableSearch } from "./model";
const item = {
  key: "checkOne",
  label: "检查内容",
  required: true,
  allowNa: false,
  merchantVisible: true,
  hint: "按实物核验",
};
describe("W207 清单版本与条目", () => {
  it("固定9编码都可创建，仅提交合法草稿条目，不伪造状态/版本", () => {
    expect(CHECKLIST_CODES).toHaveLength(9);
    for (const code of CHECKLIST_CODES)
      expect(checklistBody(code, [item]).body).toEqual({ code, items: [item] });
    expect(checklistBody("custom", [item]).body).toBeUndefined();
  });
  it("key唯一/格式/条目长度/非空规则拒绝，错误落到具体条目", () => {
    expect(checklistBody("qc.sample", [item, item]).errors.items).toBeDefined();
    expect(
      checklistBody("qc.sample", [{ ...item, key: "bad key" }]).errors["items.0.key"],
    ).toBeDefined();
    expect(
      checklistBody("qc.sample", [{ ...item, label: "字".repeat(61) }]).errors.items,
    ).toBeDefined();
    expect(checklistBody("qc.sample", []).body).toBeUndefined();
  });
  it("URL恢复合法状态/编码与客户端页码，未知筛选不能传入真实API", () => {
    expect(
      configTableSearch(
        { status: "deleted", code: "custom", page: 0, pageSize: 13, sort: "bogus", unknown: "x" },
        true,
      ),
    ).toMatchObject({ page: 1, pageSize: 20, filters: {}, sort: undefined });
    expect(configTableSearch({ status: "retired", code: "qc.sample" }, true).filters).toEqual({
      status: "retired",
      code: "qc.sample",
    });
  });
});
