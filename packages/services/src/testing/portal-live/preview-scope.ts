import { IdSchema } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import type { AdActor } from "../../ad/index.js";
import type { FactorySealer } from "../data/seal.js";
import type { PortalLivePreviewScopes } from "./preview-types.js";

export const portalLivePhones = {
  owner: "13800110001",
  clerk: "13800110002",
  otherOwner: "13800110003",
} as const;

export function assertPreviewScopes(scopes: PortalLivePreviewScopes) {
  if (!scopes || Object.keys(scopes).sort().join() !== "clerk,otherOwner,owner")
    throw new Error("PREVIEW_SCOPE_INVALID");
  for (const value of Object.values(scopes)) {
    if (
      !value ||
      Object.keys(value).sort().join() !== "entityId,merchantUserId,storeId" ||
      !Object.values(value).every((id) => IdSchema.safeParse(id).success)
    )
      throw new Error("PREVIEW_SCOPE_INVALID");
  }
  if (
    new Set(Object.values(scopes).map((scope) => scope.merchantUserId)).size !== 3 ||
    scopes.owner.entityId !== scopes.clerk.entityId ||
    scopes.owner.storeId !== scopes.clerk.storeId ||
    scopes.owner.entityId === scopes.otherOwner.entityId ||
    scopes.owner.storeId === scopes.otherOwner.storeId
  )
    throw new Error("PREVIEW_SCOPE_INVALID");
}

/** Resolve only facts produced by this fixture's real phone-login / invitation HTTP chain. */
export async function previewOwner(
  db: PrismaClient,
  clock: Clock,
  seal: FactorySealer,
  scopes: PortalLivePreviewScopes,
): Promise<AdActor> {
  assertPreviewScopes(scopes);
  let owner: AdActor | undefined;
  for (const actor of ["owner", "clerk", "otherOwner"] as const) {
    const scope = scopes[actor],
      role = actor === "clerk" ? "clerk" : "owner";
    const user = await db.merchantUser.findFirst({
      where: {
        id: scope.merchantUserId,
        phoneBidx: seal.phone("merchant_user.phone_enc", portalLivePhones[actor]).bidx,
      },
      select: { id: true, consentStamp: true },
    });
    const member = await db.entityMember.findFirst({
      where: {
        merchantUserId: scope.merchantUserId,
        entityId: scope.entityId,
        role,
        status: "active",
        ...(role === "clerk" ? { storeMemberships: { some: { storeId: scope.storeId } } } : {}),
      },
      select: { id: true },
    });
    const store = await db.store.findFirst({
      where: {
        id: scope.storeId,
        entityId: scope.entityId,
        lifecycle: "active",
        entity: { lifecycle: "active" },
      },
      select: { id: true },
    });
    const session = await db.userSession.findFirst({
      where: {
        merchantUserId: scope.merchantUserId,
        revokedAt: null,
        idleExpiresAt: { gt: clock.now() },
        absoluteExpiresAt: { gt: clock.now() },
        wechatIdentityId: { not: null },
      },
      select: { id: true, wechatIdentityId: true },
    });
    if (!user || !member || !store || !session?.wechatIdentityId)
      throw new Error("PREVIEW_HTTP_SCOPE_MISSING");
    if (actor === "owner")
      owner = {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: user.id, client: "weapp" },
          entityId: scope.entityId,
          storeId: scope.storeId,
        }),
        membership: {
          memberId: member.id,
          entityId: scope.entityId,
          storeId: scope.storeId,
          role: "owner",
          storeMode: "active",
        },
        principal: {
          sessionId: session.id,
          merchantUserId: user.id,
          wechatIdentityId: session.wechatIdentityId,
          consentStamp: user.consentStamp,
        },
      };
  }
  if (!owner) throw new Error("PREVIEW_HTTP_SCOPE_MISSING");
  return owner;
}
