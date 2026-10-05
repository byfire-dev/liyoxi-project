// 商家端：广告（docs/api/m06-ad.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as ads from "./ads.js";
import * as playables from "./playables.js";

export const M06_AD = defineRouteDoc("m06-ad", [ads, playables]);
