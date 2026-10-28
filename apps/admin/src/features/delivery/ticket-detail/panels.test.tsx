import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessContext } from "../../../lib/permissions";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { DetailApi, Ticket } from "./api";
import { SamplePanel } from "./panels";
import { batchId } from "./batch-test.fixture";

type Sample = NonNullable<Ticket["currentSample"]>;
const at = "2026-10-27T08:23:21.000Z";
const staff: Sample["uploadedBy"] = {
  staffId: batchId(501),
  staffNo: 1001,
  name: "样片测试剪辑师",
  roleKey: "editor",
  isLead: false,
  status: "active",
};
const sample: Sample = {
  sampleId: batchId(502),
  deliveryTicketId: batchId(503),
  versionNo: 1,
  status: "uploaded",
  fileId: batchId(504),
  durationMs: null,
  adSlots: [],
  adsUsed: [],
  uploadedBy: staff,
  uploadedAt: at,
  production: {
    pipelineState: "uploading",
    gate: null,
    softWarnCount: 0,
    aigcState: "not_required",
  },
  qc: null,
  pushedBy: null,
  pushedAt: null,
  previewChannels: [],
  offlineSentAt: null,
  offlineSentBy: null,
  firstViewedAt: null,
  viewedAckAt: null,
  decision: null,
  confirmDueRemindAt: null,
  watermark: null,
  preview: null,
  actions: [],
};
const passed: Sample["production"] = {
  ...sample.production!,
  pipelineState: "ready",
  gate: "pass",
};
const access: AccessSnapshot = {
  staff: {
    id: batchId(505),
    name: "质检测试经理",
    roleKey: "delivery_manager",
    roleName: "交付经理",
  },
  isLead: false,
  moduleLevels: { delivery: "o" },
  actions: ["delivery.sample.upload", "delivery.sample.qc", "delivery.sample.push"],
  dataScope: "own",
  releases: {},
};
function render(patch: Partial<Sample> = {}, permissions: AccessSnapshot | null = access) {
  // SamplePanel 在弹层关闭时只读取这两个真实工单 DTO 字段。
  const ticket = {
    currentSample: { ...sample, ...patch },
    actions: ["sample-create"],
  } satisfies Pick<Ticket, "currentSample" | "actions">;
  return renderToStaticMarkup(
    <AccessContext.Provider value={permissions}>
      <SamplePanel ticket={ticket as Ticket} api={{} as DetailApi} onRefresh={() => {}} />
    </AccessContext.Provider>,
  );
}
describe("样片体检与人工质检状态", () => {
  it.each(["uploading", "checking"])("%s期间明确等待体检，未宣称待人工质检", (pipelineState) => {
    const html = render({ production: { ...sample.production!, pipelineState } });
    expect(html).toContain(
      `<dt>体检</dt><dd>${pipelineState === "checking" ? "体检中" : "待体检"}</dd>`,
    );
    expect(html).toContain("<dt>质检</dt><dd>待体检</dd>");
    expect(html).not.toContain("待质检");
    expect(html).not.toContain("重新上传并登记新版本");
  });
  it.each([
    { status: "uploaded", production: { ...sample.production!, gate: "reject" as const } },
    { status: "uploaded", production: { ...sample.production!, pipelineState: "rejected" } },
    {
      status: "uploaded",
      production: {
        ...sample.production!,
        gate: "reject" as const,
        pipelineState: "rejected",
        aigcState: "failed" as const,
      },
    },
  ])("体检未通过但状态未终结%j时等待处理，不要求重传", (patch) => {
    const html = render(patch);
    expect(html).toContain("<dt>体检</dt><dd>体检未通过</dd>");
    expect(html).toContain("<dt>质检</dt><dd>体检未通过，暂不能质检</dd>");
    expect(html).toContain("样片体检未通过，请等待处理或刷新查看结果");
    expect(html).not.toContain("体检拒收");
    expect(html).not.toContain("重新上传并登记新版本");
    expect(html).not.toContain("待质检");
  });
  it("服务端样片状态已体检拒收时明确修正重传", () => {
    const patch = { status: "check_rejected", production: null };
    const html = render(patch);
    expect(html).toContain("<dt>体检</dt><dd>体检拒收</dd>");
    expect(html).toContain("<dt>质检</dt><dd>体检拒收，暂不能质检</dd>");
    expect(html).toContain("样片体检未通过，请修正文件后重新上传并登记新版本");
    expect(html).not.toContain("待质检");
    expect(html).toContain("上传样片");
  });
  it("体检通过后显示待质检，继续使用服务端动作和现有权限", () => {
    const patch = { production: passed, durationMs: 25493, actions: ["inspect"] };
    const html = render(patch);
    expect(html).toContain("<dt>体检</dt><dd>通过</dd>");
    expect(html).toContain("<dt>质检</dt><dd>待质检</dd>");
    expect(html).toContain("样片质检");
    expect(html).not.toContain("重新上传并登记新版本");
    expect(render(patch, null)).not.toContain("样片质检");
  });
  it.each([
    [null, "尚未生成"],
    ["processing", "生成中"],
    ["failed", "生成失败，请联系管理员处理"],
    ["ready", "已就绪"],
  ] as const)("水印状态%s可见，仍由服务端决定推送动作", (state, label) => {
    const html = render({
      status: "qc_passed",
      production: passed,
      watermark: state ? { playableAssetId: batchId(507), state, fileId: null } : null,
      actions: [],
    });
    expect(html).toContain(`<dt>水印预览</dt><dd>${label}</dd>`);
    expect(html).not.toContain("推送样片");
  });
  it.each(["pass", "fail"] as const)("保留既有人工质检%s结论、人员与条目", (verdict) => {
    const html = render({
      status: verdict === "pass" ? "qc_passed" : "qc_rejected",
      production: passed,
      actions: verdict === "pass" ? ["push"] : [],
      qc: {
        qcRecordId: batchId(506),
        targetType: "sample",
        targetId: sample.sampleId,
        checklistCode: "qc.sample",
        checklistVersionNo: 1,
        verdict,
        rejectReason: verdict === "fail" ? "画面需要调整" : null,
        items: [
          { key: "picture", label: "画面", result: verdict, note: null, merchantVisible: true },
        ],
        inspectedBy: { ...staff, staffId: access.staff.id, name: access.staff.name },
        inspectedAt: at,
      },
    });
    expect(html).toContain(`<dt>质检</dt><dd>${verdict === "pass" ? "通过" : "不通过"}</dd>`);
    expect(html).toContain("质检测试经理");
    expect(html).toContain(`画面：${verdict === "pass" ? "通过" : "不通过"}`);
    if (verdict === "fail") expect(html).toContain("画面需要调整");
    else expect(html).toContain("推送样片");
  });
});
