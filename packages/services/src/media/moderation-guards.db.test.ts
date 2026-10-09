import { expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { moderationHarness } from "./handlers/moderation/test-harness.js";
const db = useSeededDatabase("services");
it("block stays visible to authorized own store but cannot sign/link/model; other store cannot read", async () => {
  const h = await moderationHarness(db),
    file = await h.file("png", "profile_image");
  await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "block" } });
  expect(await h.media.getMerchant(h.actor, file.id)).toHaveProperty("moderationState", "block");
  await expect(h.media.signRead({ fileId: file.id })).rejects.toMatchObject({
    error: "FILE_NOT_AVAILABLE",
  });
  await expect(h.tx.run((tx) => h.media.assertUsableForModel(tx, file.id))).rejects.toMatchObject({
    error: "FILE_NOT_AVAILABLE",
  });
  await expect(
    h.tx.run((tx) =>
      h.media.link(tx, {
        fileId: file.id,
        refType: "store_profile",
        refId: h.store.id,
        role: "logo",
        entityId: h.entity.id,
        storeId: h.store.id,
      }),
    ),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "blocked" } });
  const store = await h.make.store({ entityId: h.entity.id });
  const actor = {
    ...h.actor,
    identity: createIdentityContext({
      actor: h.ctx.actor,
      entityId: h.entity.id,
      storeId: store.id,
    }),
    merchant: { ...h.actor.merchant!, storeId: store.id },
  };
  await expect(h.media.getMerchant(actor, file.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
});
it("block that commits while URL IO is pending prevents returning a newly signed URL", async () => {
  const h = await moderationHarness(db),
    file = await h.file();
  await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "pass" } });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    start = new Promise<void>((r) => {
      entered = r;
    });
  const original = h.fake.storage.presignGet;
  h.fake.storage.presignGet = async (input) => {
    entered();
    await gate;
    return original(input);
  };
  const sign = h.media.signRead({ fileId: file.id });
  await start;
  try {
    await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "block" } });
  } finally {
    release();
  }
  await expect(sign).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
});
it("actual profile subscriber recalculates current blocked-file cache, old event body never restores eligibility", async () => {
  const h = await moderationHarness(db),
    file = await h.file("png", "profile_image"),
    now = h.clock.now();
  await h.db.storeProfile.create({
    data: {
      storeId: h.store.id,
      entityId: h.entity.id,
      completenessPct: 100,
      requiredFilled: 15,
      requiredTotal: 15,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.db.storeProfileMedia.create({
    data: {
      id: uuidv7(),
      entityId: h.entity.id,
      storeId: h.store.id,
      mediaGroup: "door",
      position: 1,
      fileId: file.id,
      mediaKind: "image",
      createActorType: "merchant",
      createActorId: h.user.id,
      createClient: "weapp",
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "block" } });
  const before = await h.db.storeProfile.findUniqueOrThrow({ where: { storeId: h.store.id } });
  const subscriber = h.assembly.subscriber("profile.onFileModerated");
  if (!subscriber) throw new Error("profile moderation subscriber absent");
  await h.tx.run((tx) =>
    subscriber.handle(tx, {
      id: uuidv7(),
      type: "file.moderated",
      payload: {
        v: 1,
        fileId: file.id,
        category: "profile_image",
        moderationState: "pass",
        storeId: h.store.id,
      },
    }),
  );
  const after = await h.db.storeProfile.findUniqueOrThrow({ where: { storeId: h.store.id } });
  expect(after.completenessPct).toBeLessThan(100);
  expect(after.lockVersion).toBe(before.lockVersion);
  expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "block");
});
