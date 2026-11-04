import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { createPortalRoutes } from "../../lib/routes";
import { VerificationDetails } from "./VerificationPage";
import { createVerificationRoutes } from "./routes";
import { revisionExplanation, signatureExplanation, verificationStatus } from "./presentation";
import { VERIFICATION } from "./test-helpers";

describe("W6-12 授权状态、请求版次与待版分别展示", () => {
  it("当前/旧版/未出件版/未指定按服务器投影解释，旧版正文仍为当前正式快照", () => {
    expect(revisionExplanation(VERIFICATION)).toContain("当前第 2 版");
    const older = {
      ...VERIFICATION,
      requestedRevisionState: "outdated" as const,
      requestedRevNo: 1,
    };
    expect(revisionExplanation(older)).toContain("当前第 2 版，本次为第 1 版");
    const html = renderToStaticMarkup(<VerificationDetails value={older} />);
    expect(html).toContain("当前已出件版授权内容");
    expect(html).toContain("测试授权方");
    expect(html).toContain("第 1 版证明");
    expect(
      revisionExplanation({
        ...VERIFICATION,
        requestedRevisionState: "not_requested",
        requestedRevNo: null,
      }),
    ).toContain("未指定核对版次");
    const waiting = {
      ...VERIFICATION,
      hasPendingRevision: true,
      requestedRevisionState: "not_found" as const,
      requestedRevNo: 3,
    };
    const pending = renderToStaticMarkup(<VerificationDetails value={waiting} />);
    expect(pending).toContain("新版本生成中");
    expect(pending).toContain("未查到第 3 版的已出件记录");
    expect(pending).not.toContain("未查到这份授权书");
    expect(pending).toContain("生效中");
  });

  it("待生效使用startText，expired/voided沿服务端事实，不用本机日期反算", () => {
    expect(verificationStatus("pending_effective")).toBe("待生效");
    expect(verificationStatus("expired")).toBe("已失效");
    const pending = renderToStaticMarkup(
      <VerificationDetails
        value={{
          ...VERIFICATION,
          displayStatus: "pending_effective",
          period: { ...VERIFICATION.period, startDate: null },
        }}
      />,
    );
    expect(pending).toContain("自上线首日起");
    expect(pending).not.toContain("新版本生成中");
    const expired = renderToStaticMarkup(
      <VerificationDetails value={{ ...VERIFICATION, displayStatus: "expired" }} />,
    );
    expect(expired).toContain("已失效");
    expect(expired).not.toContain("已作废");
    const voided = renderToStaticMarkup(
      <VerificationDetails
        value={{ ...VERIFICATION, displayStatus: "voided", voidedAt: VERIFICATION.checkedAt }}
      />,
    );
    expect(voided).toContain("已作废");
    expect(voided).toContain("作废于");
    expect(voided).toContain(VERIFICATION.currentRevision.pdfSha256);
  });

  it("签署说明不把图片章当数字签名，完整公开hash可对照，无PDF或内部身份入口", () => {
    const html = renderToStaticMarkup(<VerificationDetails value={VERIFICATION} />);
    expect(html).toContain("印章图样（无数字签名）");
    expect(html).toContain("不代替 PDF 阅读器的数字签名验证");
    expect(html).toContain(VERIFICATION.currentRevision.contentFp);
    expect(html).toContain(VERIFICATION.currentRevision.pdfSha256);
    expect(html).not.toMatch(/<iframe|<embed|<object|href=|fileId|entityId|storeId|verifyCode/);
    expect(signatureExplanation("platform_cert")).toBe("平台机构数字证书签署");
    expect(signatureExplanation("esign_seal")).toBe("电子签章");
  });

  it("/v登记为公开叶，构造和匹配不读取session或票据", () => {
    const send = vi.fn<typeof fetch>(),
      runtime = createPortalRuntime({ fetch: send });
    const match = createPortalRoutes(createVerificationRoutes(runtime)).match(
      "/v?code=unit&rev=1x",
    );
    expect(match?.route.access).toBe("public");
    expect(match?.route.owner).toBe("W6-12");
    expect(send).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
