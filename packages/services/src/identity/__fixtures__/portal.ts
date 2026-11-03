import type { TxRunner } from "../../kernel/index.js";
import {
  createPortalTestStack,
  createPortalTestOwner,
  createPortalTestSession,
} from "../../testing/index.js";
import type { PortalOwnerRequest } from "../index.js";
import { META, nextOpenid, nextPhone, TEST_APPID } from "./harness.js";
import type { Harness } from "./harness.js";

export const PORTAL_ORIGIN = "https://portal.example.invalid";
export const portalStack = (h: Harness, tx: TxRunner = h.tx) =>
  createPortalTestStack({
    tx,
    clock: h.clock,
    appid: TEST_APPID,
    origin: PORTAL_ORIGIN,
    ticketTtlSeconds: 120,
  });
export const portalOwner = (h: Harness) =>
  createPortalTestOwner(h, META, {
    ...h.codes({ openid: nextOpenid(), phone: nextPhone() }),
    consents: h.consents(),
  });
export const authorizedPortal = (h: Harness, owner: PortalOwnerRequest) =>
  createPortalTestSession(portalStack(h), owner, META);
