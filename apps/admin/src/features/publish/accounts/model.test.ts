import { describe, expect, it } from "vitest";
import {
  accountSearch,
  approveBody,
  compareBody,
  createDecisionIntent,
  fields,
  initialDraft,
  rejectBody,
} from "./model";
const detail = {
  roundNo: 2,
  filled: {
    platform: "douyin" as const,
    accountName: "演练账号",
    accountUid: "demo_uid",
    accountType: "none" as const,
  },
  account: { store: { entityName: "演练主体" } },
  approval: { lockVersion: 3, confirmChecks: ["current_round"] },
};
const blank = () =>
  initialDraft({
    compareRows: fields.map((field) => ({ field, filled: null, recognized: null, match: null })),
  });
function checkedDraft() {
  const draft = blank();
  for (const field of fields) draft[field].match = true;
  draft.account_type.recognized = "none";
  draft.account_name.recognized = "演练账号";
  draft.account_uid.recognized = "demo_uid";
  return draft;
}
describe("账号核验的真实请求边界", () => {
  it("新轮次没有默认通过；缺少五项结论不能生成决定，查询只保留本队列参数", () => {
    expect(compareBody(blank(), "none", true)).toBeNull();
    expect(accountSearch({ tab: "unknown", q: "x".repeat(60), page: 2 })).toEqual({
      tab: "todo",
      q: "x".repeat(30),
      id: undefined,
    });
  });
  it("绑定当前轮次/账号/锁版本，确认项和启用清单必选；非企业主体规范为null", () => {
    const draft = checkedDraft(),
      template = {
        versionNo: 4,
        items: [
          {
            key: "name_checked",
            label: "名称",
            required: true,
            allowNa: false,
            merchantVisible: false,
          },
        ],
      };
    draft.cert_subject_name.recognized = "之前识别的企业名";
    expect(approveBody(detail, draft, "none", template, [])).toBeNull();
    expect(approveBody(detail, draft, "none", template, ["name_checked"])).toBeNull();
    const body = approveBody(detail, draft, "none", template, [
      "name_checked",
      "confirm:current_round",
    ]);
    expect(body).toMatchObject({
      lockVersion: 3,
      confirm: { roundNo: 2, accountUid: "demo_uid" },
      certSubjectName: null,
      checklistVersionNo: 4,
      results: [{ key: "name_checked", result: "pass" }],
      confirmChecks: ["current_round"],
    });
    expect(
      body?.compareRows.find((row) => row.field === "cert_subject_name")?.recognized,
    ).toBeNull();
  });
  it("企业主体不匹配不可通过；不一致可驳回且驳回只发strict三字段", () => {
    const draft = checkedDraft();
    draft.account_type.recognized = "enterprise";
    draft.cert_subject_name.recognized = "其他主体";
    expect(
      approveBody(detail, draft, "enterprise", undefined, ["confirm:current_round"]),
    ).toBeNull();
    draft.cert_subject_name.recognized = "演练 主体";
    expect(
      approveBody(detail, draft, "enterprise", undefined, ["confirm:current_round"]),
    ).not.toBeNull();
    draft.account_name.match = false;
    expect(
      approveBody(detail, draft, "enterprise", undefined, ["confirm:current_round"]),
    ).toBeNull();
    expect(rejectBody(draft, "enterprise", "", "需补正")).toBeNull();
    expect(rejectBody(draft, "enterprise", "R01", " ")).toBeNull();
    expect(rejectBody(draft, "enterprise", "R01", "x".repeat(201))).toBeNull();
    expect(Object.keys(rejectBody(draft, "enterprise", "R01", " 名称不一致 ")!).sort()).toEqual([
      "compareRows",
      "note",
      "reasonCode",
    ]);
  });
  it("按钮更新前的同步重入不发第二次；同内容失败重试保留键，修改内容换键", async () => {
    let serial = 0,
      writes = 0;
    const intent = createDecisionIntent(() => `key-${++serial}`),
      keys: string[] = [];
    let release!: () => void;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = intent({ id: "round1", action: "approve" }, async (key) => {
      keys.push(key);
      writes++;
      await blocking;
      throw new Error("网络中断");
    });
    expect(
      await intent({ id: "round1", action: "approve" }, async () => {
        writes++;
      }),
    ).toBeNull();
    release();
    await expect(first).rejects.toThrow("网络中断");
    await intent({ id: "round1", action: "approve" }, async (key) => {
      keys.push(key);
      writes++;
    });
    await intent({ id: "round1", action: "reject" }, async (key) => {
      keys.push(key);
      writes++;
    });
    expect(keys).toEqual(["key-1", "key-1", "key-2"]);
    expect(writes).toBe(3);
  });
});
