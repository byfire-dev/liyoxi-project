import type { DeliveryRelease, DownloadGrant, FileObject } from "@liyoxi/db";
import { endOfDay } from "@liyoxi/shared/time";
import { AppError } from "../../kernel/index.js";
import type { DownloadItem } from "./repo.js";
export function unavailableReason(item: DownloadItem, release: DeliveryRelease | null, now: Date) {
  if (!release) return "not_delivered";
  if (release.state !== "pushed") return "release_closed";
  if (["cancelled", "refunded", "terminated", "ended"].includes(item.phase))
    return "order_item_closed";
  if (now >= endOfDay(item.usageEndDate.toISOString().slice(0, 10))) return "usage_ended";
  return null;
}
export const fileAvailable = (file: FileObject | null, item: DownloadItem) =>
  !!file &&
  file.status === "stored" &&
  file.moderationState !== "block" &&
  file.entityId === item.entityId &&
  file.storeId === item.storeId;
export function canDownload(
  item: DownloadItem,
  release: DeliveryRelease | null,
  grant: DownloadGrant | null,
  now: Date,
  files: readonly (FileObject | null)[],
) {
  if (unavailableReason(item, release, now)) return false;
  return (
    !!grant &&
    grant.state === "active" &&
    grant.expiresAt > now &&
    grant.deliveryReleaseId === release!.id &&
    files.length > 0 &&
    files.every((file) => fileAvailable(file, item))
  );
}
export const canRegenerate = (
  item: DownloadItem,
  release: DeliveryRelease | null,
  now: Date,
  remaining: number,
) =>
  !unavailableReason(item, release, now) &&
  ["to_launch", "live"].includes(item.phase) &&
  remaining > 0;
export function unavailable(
  reason: NonNullable<ReturnType<typeof unavailableReason>> | "file_unavailable",
): never {
  throw new AppError("DOWNLOAD_NOT_AVAILABLE", { details: { reason } });
}
export function invalidGrant(
  grant: DownloadGrant | null,
  canRegenerate: boolean,
  fallback?: "superseded",
): never {
  throw new AppError("DOWNLOAD_GRANT_INVALID", {
    details: {
      reason: fallback ?? (!grant ? "missing" : grant.state === "active" ? "expired" : grant.state),
      expiresAt: grant?.expiresAt.toISOString() ?? null,
      canRegenerate,
    },
  });
}
