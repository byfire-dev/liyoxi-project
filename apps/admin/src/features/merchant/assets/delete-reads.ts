import type { QueryClient } from "@tanstack/react-query";
import { ASSET_READ_KEY } from "./model";

export interface AssetDeleteReads {
  paused(): boolean;
  before(): Promise<void>;
  committed(): Promise<void>;
  dismiss(): Promise<void>;
  restore(): void;
}

// 删除期间不再读取即将消失的详情；成功后只刷新仍存在的集合。
export function createAssetDeleteReads(
  client: QueryClient,
  scope: string,
  storeId: string,
  assetId: string | undefined,
  changed: () => void,
): AssetDeleteReads {
  const prefix = [...ASSET_READ_KEY, scope, storeId],
    detail = { queryKey: [...prefix, "detail", assetId] };
  let paused = false;
  const leaveDetail = async () => {
    await client.cancelQueries(detail);
    client.removeQueries(detail);
    await Promise.all([
      client.invalidateQueries({ queryKey: [...prefix, "list"] }),
      client.invalidateQueries({ queryKey: [...prefix, "summary"] }),
    ]);
  };
  return {
    paused: () => paused,
    async before() {
      paused = true;
      changed();
      await client.cancelQueries(detail);
    },
    committed: leaveDetail,
    // 未知结果时取消确认也只退出详情；是否已删由真实列表回读决定。
    dismiss: leaveDetail,
    restore() {
      paused = false;
      changed();
    },
  };
}
