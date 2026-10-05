// 后台：客服工单（docs/api/a08-support.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as quickReplies from "./quick-replies.js";
import * as serviceTickets from "./service-tickets.js";

export const A08_SUPPORT = defineRouteDoc("a08-support", [quickReplies, serviceTickets]);
