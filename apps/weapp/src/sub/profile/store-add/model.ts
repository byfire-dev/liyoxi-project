import type { Body, Stores } from "../../member/members/api";
export const canCreateStore = (data: Stores | undefined) =>
  data?.viewerRole === "owner" && data.entity.canAddStore;
export function storeCreateBody(input: {
  name: string;
  detail: string;
  industry: string | null;
  category: string | null;
  addressPrefix: string;
  sourceId: string | null;
  options: Body<"m.store.create">["copyOptions"];
}): Body<"m.store.create"> {
  if (!input.industry || !input.category) throw new Error("请选择行业与品类");
  return {
    name: input.name.trim(),
    addressDetail: `${input.addressPrefix}${input.detail}`.trim(),
    industryCode: input.industry,
    categoryCode: input.category,
    ...(input.sourceId && input.options?.length
      ? { copyFromStoreId: input.sourceId, copyOptions: input.options }
      : {}),
  };
}
