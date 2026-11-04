import type { components } from "@liyoxi/contract/types/portal";

import type { PortalClient } from "../../lib/api";
import { object, PortalApiError } from "../../lib/api-errors";

export type PortalSession = NonNullable<components["schemas"]["PortalSessionView"]>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Validate nullable generated DTOs, then project only the declared session fields. */
export function readPortalSession(value: unknown): PortalSession | null {
  if (value === null) return null;
  const session = object(value);
  if (
    !session ||
    ![session.portalSessionId, session.entityId, session.storeId].every(
      (id) => typeof id === "string" && uuid.test(id),
    ) ||
    !nullableText(session.storeName) ||
    !nullableText(session.entityName) ||
    !nullableText(session.authorizerPhoneMask) ||
    typeof session.isStoreArchived !== "boolean" ||
    session.grantScope !== "store" ||
    !Array.isArray(session.capabilities) ||
    !session.capabilities.every(
      (item) => typeof item === "string" && /^[a-zA-Z][a-zA-Z0-9.]*$/.test(item),
    ) ||
    !instant(session.authorizedAt) ||
    !instant(session.expiresAt) ||
    !instant(session.serverTime)
  ) {
    throw new PortalApiError("INVALID_RESPONSE");
  }
  return Object.freeze({
    portalSessionId: session.portalSessionId as string,
    entityId: session.entityId as string,
    storeId: session.storeId as string,
    storeName: session.storeName,
    entityName: session.entityName,
    authorizerPhoneMask: session.authorizerPhoneMask,
    isStoreArchived: session.isStoreArchived,
    grantScope: "store",
    capabilities: [...session.capabilities] as string[],
    authorizedAt: session.authorizedAt,
    expiresAt: session.expiresAt,
    serverTime: session.serverTime,
  });
}

export function createPortalSessionApi(client: PortalClient) {
  return {
    async current(signal?: AbortSignal): Promise<PortalSession | null> {
      return readPortalSession(
        await client.request("/api/v1/portal/sessions/current", "get", { signal }),
      );
    },
    async logout(signal?: AbortSignal): Promise<void> {
      const data = await client.request("/api/v1/portal/sessions/current", "delete", { signal });
      if (data !== null) throw new PortalApiError("INVALID_RESPONSE");
    },
  };
}
