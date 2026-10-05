// 外部回调与探活（docs/api/h01-hooks.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as asr from "./asr.js";
import * as ci from "./ci.js";
import * as esign from "./esign.js";
import * as probes from "./probes.js";
import * as sms from "./sms.js";
import * as wechat from "./wechat.js";
import * as wechatpay from "./wechatpay.js";
import * as wecom from "./wecom.js";

export const H01_HOOKS = defineRouteDoc("h01-hooks", [
  asr,
  ci,
  esign,
  probes,
  sms,
  wechat,
  wechatpay,
  wecom,
]);
