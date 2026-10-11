import type { Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import type { ModelBudgetContext, ModelBudgetFacts } from "../media/index.js";

/** 同一短事务读取正式参数；report只记本次非法值，不能外呼或静默放行回退值。 */
export async function readModelBudgetPermit(
  tx: Tx,
  facts: ModelBudgetFacts,
): Promise<ModelBudgetContext | null> {
  let invalid = false;
  const values = await paramsAt(
    tx,
    ["media.assets.daily_file_cap", "media.model.daily_call_cap"],
    new Date(facts.readAtMs),
    {
      report: () => {
        invalid = true;
      },
    },
  );
  if (invalid) throw new TypeError("模型预算参数非法");
  const dailyFileCap = values["media.assets.daily_file_cap"];
  const dailyCallCap = values["media.model.daily_call_cap"];
  if (
    !Number.isInteger(dailyFileCap) ||
    dailyFileCap < 0 ||
    dailyFileCap > 200 ||
    !Number.isInteger(dailyCallCap) ||
    dailyCallCap < 0 ||
    dailyCallCap > 10000
  )
    throw new TypeError("模型预算参数非法");
  return dailyFileCap === 0 || dailyCallCap === 0
    ? null
    : Object.freeze({
        ...facts,
        fileIds: Object.freeze([...facts.fileIds]),
        dailyFileCap,
        dailyCallCap,
      });
}
