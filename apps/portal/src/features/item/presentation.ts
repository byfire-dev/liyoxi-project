import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import type { Release } from "./api";

export const dateText = (value: string) => appDateTimeFormat.dateTime(value);
export function sizeText(value: string): string {
  const size = Number(value);
  return size >= 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(2)} GB`
    : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
export function blockerText(blocker: Release["downloadBlocker"]): string {
  if (!blocker) return "当前成片暂不可下载，请回到小程序查看授权状态。";
  const messages: Record<string, string> = {
    expired: "下载授权已到期，请在小程序重新授权。",
    missing: "暂无下载授权，请回到小程序查看。",
    superseded: "下载授权已更新，请刷新成片详情。",
    revoked: "下载授权已撤销，请联系服务经理。",
    not_delivered: "成片尚未交付，请稍后再来。",
    release_closed: "当前成片包已关闭，请联系服务经理。",
    order_item_closed: "该订购项已关闭，暂不可下载。",
    usage_ended: "成片使用期已结束，暂不可下载。",
    file_unavailable: "成片文件暂不可用，请联系服务经理。",
  };
  return messages[blocker.reason] ?? "当前成片暂不可下载，请回到小程序查看授权状态。";
}
