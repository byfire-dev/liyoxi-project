import { fenToYuan, yuanToFen } from "@liyoxi/shared/format/money";
import { ApiError } from "../../../lib/request";
/** 意图键与同步闩：失败重试相同内容沿用键，改内容换键，重复触发只调用一次。 */
export function createIntent(key: () => string) {
  let fingerprint: string | null = null;
  let id: string | null = null;
  let busy = false;
  return {
    async run<T>(body: unknown, call: (id: string) => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      const next = JSON.stringify(body);
      if (fingerprint !== next) {
        fingerprint = next;
        id = key();
      }
      busy = true;
      try {
        const value = await call(id!);
        fingerprint = null;
        id = null;
        return value;
      } finally {
        busy = false;
      }
    },
  };
}
export function errorInfo(error: unknown): {
  message: string;
  conflict: boolean;
  step: number | null;
  missing: string[];
} {
  if (!(error instanceof ApiError))
    return {
      message: error instanceof Error ? error.message : "操作失败，请重试",
      conflict: false,
      step: null,
      missing: [],
    };
  const details = error.details as {
    missing?: { step: number; item: string; permitType?: string | null }[];
    rejectedNotReplaced?: { docType: string; permitType: string | null }[];
  } | null;
  const labels: Record<string, string> = {
    brand_name: "品牌名称",
    store_name: "门店名称",
    industry: "行业品类",
    address: "门店地址",
    business_hours: "营业时间",
    store_tel: "门店电话",
    avg_spend: "人均消费",
    door_photos: "门头照片",
    interior_photos: "店内环境照片",
    service_items: "主推服务",
    selling_points: "核心卖点",
    entity_type: "主体类型",
    business_license: "营业执照",
    contact: "资质联系人",
    declaration: "信息确认",
    permit: "行业许可证",
  };
  return {
    message:
      error.error === "VERSION_CONFLICT"
        ? "资料已更新，已保留本次输入。请先刷新核对，再保存"
        : error.error === "DECLARATION_REQUIRED"
          ? "信息确认已更新，请刷新后重新阅读并确认"
          : error.message,
    conflict: error.error === "VERSION_CONFLICT" || error.error === "DECLARATION_REQUIRED",
    step: details?.missing?.[0]?.step ?? null,
    missing:
      details?.missing?.map((item) => labels[item.item] ?? "资料项目") ??
      details?.rejectedNotReplaced?.map((item) =>
        item.docType === "industry_permit" ? "被驳回的许可证" : "被驳回的执照",
      ) ??
      [],
  };
}
/** 用户输入的金额转分，只作无损格式转换，不计算价格、套餐或资格。 */
export function parseFen(value: string): number | null {
  if (!value.trim()) return null;
  return yuanToFen(value);
}
export function yuan(fen: number | null | undefined): string {
  return fen == null ? "" : fenToYuan(fen);
}

export function generationGuard(context: () => string) {
  let generation = 0;
  return {
    invalidate: () => {
      generation++;
    },
    async run<T>(call: () => Promise<T>) {
      const epoch = generation,
        current = context();
      const value = await call();
      return epoch === generation && current === context() ? value : undefined;
    },
  };
}
