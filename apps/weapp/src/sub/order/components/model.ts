import { ApiError } from "@/lib/request";
const reasons: Record<string, string> = {
  unparsable: "无法识别",
  not_https: "请使用 HTTPS",
  too_long: "链接过长",
  has_credentials: "不能含账号密码",
  duplicate_episode: "集号重复",
  episode_out_of_range: "集号超出范围",
};
export function deliveryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.error === "PLAN_VERSION_STALE") return "方案已更新，请查看最新版本后再确认";
    if (error.error === "SAMPLE_VERSION_STALE") return "样片已更新，请查看最新版本";
    if (error.error === "SAMPLE_NOT_VIEWABLE") return "当前样片不可查看，请刷新或联系服务经理";
    if (error.error === "DOWNLOAD_GRANT_INVALID") return "下载授权已过期，请联系服务经理";
    if (error.error === "LINK_INVALID") {
      const details = error.details as { field?: string; reason?: string } | null;
      return `请检查${details?.field ?? "链接"}：${reasons[details?.reason ?? ""] ?? "链接无效"}`;
    }
  }
  return error instanceof Error ? error.message : "操作失败，请重试";
}
