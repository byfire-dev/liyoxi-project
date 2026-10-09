import { expect, it } from "vitest";
import { useSeededDatabase } from "../../../testing/index.js";
import { uuidv7 } from "../../../kernel/index.js";
import { moderationHarness } from "./test-harness.js";
const db = useSeededDatabase("services");
it("real promote chooses WX, 35min creates exactly one CI fallback and late callback cannot overwrite", async () => {
  const h = await moderationHarness(db, { wx: true });
  const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const registration = (
    await h.media.register(h.actor, {
      category: "profile_image",
      files: [{ fileName: "fictional.png", sizeBytes: String(body.length), clientToken: uuidv7() }],
    })
  ).items[0]!;
  h.fake.storage.put({ bucket: "asset", key: registration.key }, body, "image/png");
  await h.media.complete(h.actor, registration.fileId);
  const promote = await h.db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${registration.fileId}` },
  });
  await h.media.promote({ jobId: promote.id });
  const wx = await h.db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `audit_image_wx:${registration.fileId}:v1` },
  });
  await h.media.promote({ jobId: wx.id });
  const submitted = await h.currentJob(wx.id);
  expect(submitted).toMatchObject({ state: "submitted", attemptNo: 1 });
  h.clock.advance(35 * 60_000);
  await Promise.all([h.media.promote({ jobId: wx.id }), h.media.promote({ jobId: wx.id })]);
  const ci = await h.db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `audit_image:${registration.fileId}:v1` },
  });
  expect(
    await h.db.mediaJob.count({ where: { subjectId: registration.fileId, kind: "audit_image" } }),
  ).toBe(1);
  await h.media.promote({ jobId: ci.id });
  expect(await h.currentFile(registration.fileId)).toHaveProperty("moderationState", "pass");
  expect(
    await h.tx.run((tx) =>
      h.media.applyWechatImageResult(
        tx,
        {
          traceId: submitted.externalJobId!,
          result: { suggest: "risky", label: 20001 },
          receivedAt: h.clock.now(),
        },
        h.ctx,
      ),
    ),
  ).toBe("ignored");
  expect(await h.conclusions(registration.fileId)).toHaveLength(1);
  expect(await h.currentFile(registration.fileId)).toHaveProperty("moderationState", "pass");
});
it("WX callback conclusion emits once; a duplicate pass cannot reverse a block", async () => {
  const h = await moderationHarness(db, { wx: true }),
    file = await h.file("png", "profile_image");
  const now = h.clock.now(),
    trace = uuidv7(),
    jobId = uuidv7();
  await h.db.mediaJob.create({
    data: {
      id: jobId,
      kind: "audit_image_wx",
      provider: "wechat",
      mode: "remote",
      subjectType: "file_object",
      subjectId: file.id,
      state: "submitted",
      attemptNo: 1,
      externalJobId: trace,
      dedupeKey: `audit_image_wx:${file.id}:v1`,
      input: { src: { bucket: file.bucket, key: file.objectKey }, scenes: ["profile"] },
      nextRunAt: now,
      deadlineAt: new Date(now.getTime() + 35 * 60_000),
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const suggest of ["risky", "pass", "review"] as const)
    await h.tx.run((tx) =>
      h.media.applyWechatImageResult(
        tx,
        { traceId: trace, result: { suggest, label: 20001 }, receivedAt: now },
        h.ctx,
      ),
    );
  expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "block");
  expect(await h.conclusions(file.id)).toHaveLength(1);
});
it("a real WX generation snapshot rejects a callback after the stored etag changes", async () => {
  const h = await moderationHarness(db, { wx: true }),
    file = await h.file("png", "profile_image");
  const now = h.clock.now(),
    trace = uuidv7(),
    jobId = uuidv7();
  await h.db.mediaJob.create({
    data: {
      id: jobId,
      kind: "audit_image_wx",
      provider: "wechat",
      mode: "remote",
      subjectType: "file_object",
      subjectId: file.id,
      state: "submitted",
      attemptNo: 1,
      externalJobId: trace,
      dedupeKey: `audit_image_wx:${file.id}:v1`,
      input: {
        src: { bucket: file.bucket, key: file.objectKey, etag: file.etag },
        scenes: ["profile"],
      },
      nextRunAt: now,
      deadlineAt: new Date(now.getTime() + 35 * 60_000),
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.db.fileObject.update({
    where: { id: file.id },
    data: { etag: "a-different-stored-generation" },
  });
  expect(
    await h.tx.run((tx) =>
      h.media.applyWechatImageResult(
        tx,
        { traceId: trace, result: { suggest: "pass", label: 100 }, receivedAt: now },
        h.ctx,
      ),
    ),
  ).toBe("ignored");
  expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pending");
  expect(await h.conclusions(file.id)).toEqual([]);
});
