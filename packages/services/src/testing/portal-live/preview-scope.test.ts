import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../../kernel/index.js";
import { createClock } from "../clock.js";
import { testSealer } from "../data/seal.js";
import { assertPreviewScopes, previewOwner } from "./preview-scope.js";
import type { PortalLivePreviewScopes } from "./preview-types.js";

const scopes = (): PortalLivePreviewScopes => {
  const owner = { merchantUserId: uuidv7(), entityId: uuidv7(), storeId: uuidv7() };
  return {
    owner,
    clerk: { ...owner, merchantUserId: uuidv7() },
    otherOwner: { merchantUserId: uuidv7(), entityId: uuidv7(), storeId: uuidv7() },
  };
};
it("rejects cross-store clerk, reused owner IDs, and secret-bearing extra inputs before any DB access", () => {
  const value = scopes();
  expect(() => assertPreviewScopes(value)).not.toThrow();
  for (const bad of [
    { ...value, clerk: { ...value.clerk, storeId: value.otherOwner.storeId } },
    { ...value, otherOwner: value.owner },
    { ...value, owner: { ...value.owner, token: "private-token-sentinel" } },
    { ...value, owner: { ...value.owner, merchantUserId: "not-an-id" } },
  ])
    expect(() => assertPreviewScopes(bad)).toThrow("PREVIEW_SCOPE_INVALID");
});

it("does not synthesize a principal for a membership without an actual live HTTP user session", async () => {
  const db = {
    merchantUser: { findFirst: vi.fn().mockResolvedValue({ id: uuidv7() }) },
    entityMember: { findFirst: vi.fn().mockResolvedValue({ id: uuidv7() }) },
    store: { findFirst: vi.fn().mockResolvedValue({ id: uuidv7() }) },
    userSession: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  await expect(
    previewOwner(db as unknown as PrismaClient, createClock(), testSealer, scopes()),
  ).rejects.toThrow("PREVIEW_HTTP_SCOPE_MISSING");
  expect(db.userSession.findFirst.mock.calls[0]?.[0]).toMatchObject({
    where: { revokedAt: null, wechatIdentityId: { not: null } },
    select: { id: true, wechatIdentityId: true },
  });
  expect(JSON.stringify(db.userSession.findFirst.mock.calls)).not.toContain("tokenHash");
});
