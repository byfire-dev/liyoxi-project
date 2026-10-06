import { beforeAll, describe, expect, it } from "vitest";
import { createIdempotencyContext } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { harness, ownedFile } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("档案幂等与引用", () => {
  it("带签名地址首响应现签，持久结果无地址，重放不签且不增副作用", async () => {
    const { viewer } = await h.owner(),
      file = await ownedFile(h, viewer);
    const body = { draft: true, lockVersion: 0, logoFileId: file.id };
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "m.storeProfile.basic.update",
        key: "profile-logo-replay",
        actor: viewer.ctx.actor,
        request: { method: "PATCH", body },
        redact: ["logo.url", "logo.expiresAt", "logo.coverUrl"],
      });
    const first = await h.profile.updateBasic(viewer, body, { idem: idem() });
    expect(first.logo!.url).toMatch(/^https:/);
    const calls = h.fake.storage.callsOf("presignGet").length;
    const replay = await h.profile.updateBasic(viewer, body, { idem: idem() });
    expect(replay).toMatchObject({
      replayed: true,
      logo: { url: null, expiresAt: null, coverUrl: null },
    });
    expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
    expect(await h.prisma.fileRef.count({ where: { fileId: file.id } })).toBe(1);
    expect(
      (
        await h.prisma.storeProfile.findUniqueOrThrow({
          where: { storeId: viewer.membership.storeId },
        })
      ).lockVersion,
    ).toBe(1);
  });
  it("同类证照重新上传仅新行live，旧行removed与released保留七天；done重放无新行", async () => {
    const { viewer } = await h.owner(),
      a = await ownedFile(h, viewer, "kyc_license"),
      b = await ownedFile(h, viewer, "kyc_license");
    const old = await h.profile.createDocument(viewer, {
      docType: "business_license",
      fileId: a.id,
    });
    const body = { docType: "business_license" as const, fileId: b.id };
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "m.qualificationDoc.create",
        key: "profile-doc-replay",
        actor: viewer.ctx.actor,
        request: { method: "POST", body },
        redact: ["recognized", "submitted"],
      });
    const created = await h.profile.createDocument(viewer, body, { idem: idem() });
    const replay = await h.profile.createDocument(viewer, body, { idem: idem() });
    expect(replay).toMatchObject({ replayed: true, recognized: null, submitted: null });
    expect(created.doc.qualificationDocId).toBe(replay.doc.qualificationDocId);
    expect(
      await h.prisma.qualificationDoc.count({ where: { storeId: viewer.membership.storeId } }),
    ).toBe(2);
    expect(
      (
        await h.prisma.qualificationDoc.findUniqueOrThrow({
          where: { id: old.doc.qualificationDocId },
        })
      ).removedAt,
    ).not.toBeNull();
    const ref = await h.prisma.fileRef.findFirstOrThrow({
      where: { fileId: a.id, refId: old.doc.qualificationDocId },
    });
    expect(ref.state).toBe("released");
    expect(ref.keepUntil!.getTime()).toBeGreaterThanOrEqual(h.clock.now().getTime() + 7 * 86400000);
  });
  it("新文件跨用户/范围被拒；同店现有文件可保留与重新排序", async () => {
    const first = await h.owner(),
      other = await h.owner();
    const foreign = await ownedFile(h, other.viewer);
    await expect(
      h.profile.updateMedia(first.viewer, {
        draft: true,
        lockVersion: 0,
        groups: { door: [{ fileId: foreign.id }] },
      }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
    const a = await ownedFile(h, first.viewer),
      b = await ownedFile(h, first.viewer);
    await h.profile.updateMedia(first.viewer, {
      draft: true,
      lockVersion: 0,
      groups: { door: [{ fileId: a.id }, { fileId: b.id }] },
    });
    const result = await h.profile.updateMedia(first.viewer, {
      draft: true,
      lockVersion: 1,
      groups: { door: [{ fileId: b.id }, { fileId: a.id }] },
    });
    expect(
      result.groups.door.map((row) => (row as { file: { fileId: string } }).file.fileId),
    ).toEqual([b.id, a.id]);
  });
});
it("视频及其已抽取封面均在事务后签发，block封面不签", async () => {
  const { viewer } = await h.owner();
  const video = await h.make.fileObject({
    category: "profile_video",
    bucket: "asset",
    mime: "video/mp4",
    ext: "mp4",
    scopeType: "store",
    storeId: viewer.membership.storeId,
    entityId: viewer.membership.entityId,
    uploadActorType: "merchant",
    uploadActorId: viewer.principal.merchantUserId,
    uploadClient: "weapp",
  });
  const cover = await h.make.fileObject({
    category: "video_cover",
    bucket: "asset",
    scopeType: "platform",
    uploadActorType: "system",
    uploadActorId: null,
    uploadClient: null,
  });
  await h.prisma.mediaInfo.create({
    data: {
      fileId: video.id,
      kind: "video",
      durationMs: 50000,
      coverFileId: cover.id,
      probeVersion: 1,
      raw: {},
      probedAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.profile.updateMedia(viewer, {
    draft: true,
    lockVersion: 0,
    groups: { product: [{ fileId: video.id }] },
  });
  const file = (await h.profile.media(viewer)).groups.product[0] as {
    file: { url: string | null; coverUrl: string | null };
  };
  expect(file.file.url).toMatch(/^https:/);
  expect(file.file.coverUrl).toMatch(/^https:/);
  await h.prisma.fileObject.update({ where: { id: cover.id }, data: { moderationState: "block" } });
  expect(
    ((await h.profile.media(viewer)).groups.product[0] as typeof file).file.coverUrl,
  ).toBeNull();
});
