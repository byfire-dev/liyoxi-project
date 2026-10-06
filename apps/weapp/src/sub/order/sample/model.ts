import type { DeliveryApi, Sample } from "../components/delivery-api";
export function sampleConfirmation(view: Sample, checked: boolean) {
  if (!checked || !view?.confirmableVia.length || !view.actions.includes("confirm"))
    throw new Error("请先保存样片查看，再勾选已查看");
  return { versionNo: view.versionNo, viewedVia: view.confirmableVia[0]!, hasViewed: true };
}
export async function saveSample(
  api: Pick<DeliveryApi, "sample" | "sampleUrl">,
  view: NonNullable<Sample>,
  save: (url: string) => Promise<void>,
  current: () => boolean,
) {
  const signed = await api.sampleUrl(view.sampleId);
  if (!current()) return null;
  await save(signed.url);
  if (!current()) return null;
  return api.sample(view.orderItemId);
}
