// 缺省种子未含行政区划/门店卖点；只为本轮接口重放补合法基准字典，不造业务状态。
import { insertDictItemsMissing } from "../config/index.js";
import type { Runtime } from "../runtime.js";
export const M1_PROFILE_DEFAULTS = {
  industryCode: "C07",
  categoryCode: "C08",
  sellingPointCodes: ["SP01"],
  address: {
    provinceCode: "110000",
    cityCode: "110100",
    districtCode: "110101",
    zoneCode: null,
    detail: "演示路一号",
    poiName: null,
    latitude: null,
    longitude: null,
  },
} as const;
export async function seedM1ProfileDefaults(runtime: Runtime) {
  const common = { description: null, position: 0 };
  const result = await runtime.tx.run((tx) =>
    insertDictItemsMissing(
      tx,
      [
        {
          ...common,
          dictTypeKey: "region",
          code: "110000",
          name: "演示省",
          parentCode: null,
          ext: { level: 1, functionalZone: false, opened: true },
        },
        {
          ...common,
          dictTypeKey: "region",
          code: "110100",
          name: "演示市",
          parentCode: "110000",
          ext: { level: 2, functionalZone: false, opened: true },
        },
        {
          ...common,
          dictTypeKey: "region",
          code: "110101",
          name: "演示区",
          parentCode: "110100",
          ext: { level: 3, functionalZone: false, opened: true },
        },
        {
          ...common,
          dictTypeKey: "store_selling_point",
          code: "SP01",
          name: "演示门店特色",
          parentCode: null,
          ext: { categoryCodes: ["C08"] },
        },
      ],
      runtime.clock.now(),
    ),
  );
  if (result.inserted > 0) await runtime.config.cache.bump("dict");
  return result;
}
