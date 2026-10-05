// 商家端：主体、门店与成员（docs/api/m02-tenant.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as delegations from "./delegations.js";
import * as entities from "./entities.js";
import * as invitations from "./invitations.js";
import * as me from "./me.js";
import * as members from "./members.js";
import * as portalSessions from "./portal-sessions.js";
import * as portalTickets from "./portal-tickets.js";
import * as stores from "./stores.js";

export const M02_TENANT = defineRouteDoc("m02-tenant", [
  delegations,
  entities,
  invitations,
  me,
  members,
  portalSessions,
  portalTickets,
  stores,
]);
