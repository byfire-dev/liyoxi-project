import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";

/** 协议生效日按应用北京时间显示；已经是日历日期的输入不再换日。 */
export const agreementEffectiveDate = (value: string): string => appDateTimeFormat.date(value);
