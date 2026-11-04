import type { LicenseVerification } from "./api";

export function verificationStatus(value: LicenseVerification["displayStatus"]): string {
  return (
    { pending_effective: "待生效", effective: "生效中", expired: "已失效", voided: "已作废" }[
      value
    ] ?? "状态待核对"
  );
}
export function revisionExplanation(value: LicenseVerification): string {
  switch (value.requestedRevisionState) {
    case "current":
      return `核对的是当前第 ${value.currentRevision.revNo} 版`;
    case "outdated":
      return `已有更新版本：当前第 ${value.currentRevision.revNo} 版，本次为第 ${value.requestedRevNo} 版`;
    case "not_found":
      return `未查到第 ${value.requestedRevNo} 版的已出件记录，以下为当前已出件版本`;
    default:
      return "未指定核对版次，请对照内容指纹";
  }
}
export function revisionReason(reason: string): string {
  return (
    (
      {
        initial: "首次出件",
        go_live: "上线补充",
        period_changed: "授权期限调整",
        correction: "内容更正",
        resign: "重新签署",
      } as Record<string, string>
    )[reason] ?? "版次更新"
  );
}
export function signatureExplanation(mode: string): string {
  return (
    (
      {
        platform_cert: "平台机构数字证书签署",
        esign_seal: "电子签章",
        stamp: "印章图样（无数字签名）",
      } as Record<string, string>
    )[mode] ?? "签署方式待核对"
  );
}
