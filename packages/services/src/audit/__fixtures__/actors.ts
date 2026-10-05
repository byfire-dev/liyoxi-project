// audit 用例共用的操作人与请求元信息。id 都是现造的 UUID v7。
import { createActor, uuidv7 } from "../../kernel/index.js";
import type { AuditRequestMeta } from "../record.js";

export const STAFF_ID = uuidv7();
export const USER_ID = uuidv7();
export const ENTITY_ID = uuidv7();
export const STORE_ID = uuidv7();
export const SESSION_ID = uuidv7();

export const staff = createActor({ type: "staff", id: STAFF_ID, client: "admin" });
export const owner = createActor({ type: "merchant", id: USER_ID, client: "weapp", role: "owner" });
export const clerk = createActor({
  type: "merchant",
  id: USER_ID,
  client: "portal",
  role: "clerk",
});
export const cliStaff = createActor({ type: "staff", id: STAFF_ID, client: "cli" });
export const system = createActor({ type: "system", job: "timers.points_expire" });

/** 后台请求的元信息 */
export const adminMeta: AuditRequestMeta = {
  requestId: "req-0001",
  ip: "182.139.20.52",
  userAgent: "Mozilla/5.0 (Macintosh)",
  authMethod: "password+totp",
  sessionId: SESSION_ID,
  actorName: "林晓",
  actorRole: "财务",
};
export const weappMeta: AuditRequestMeta = {
  ...adminMeta,
  authMethod: "weapp",
  actorName: null,
  actorRole: null,
};
/** 没有请求的场合：系统任务、命令行 */
export const noRequest: AuditRequestMeta = {
  requestId: null,
  ip: null,
  userAgent: null,
  authMethod: null,
  sessionId: null,
};
