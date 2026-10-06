// 只适配真实计价读侧；content 不复制账本取价算法。
import type { DramaPrices } from "../../content/index.js";
import { paramsAt, priceAt } from "./index.js";
export const dramaPriceAdapter: DramaPrices = {
  priceAt,
  minLicenseMonths: async (tx, at) => (await paramsAt(tx, at)).minLicenseMonths,
};
