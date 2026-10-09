import { describe, expect, it, vi } from "vitest";
import { failed, ok } from "../../../providers/types.js";
import { assertNotInTransaction, lockRows } from "../../../kernel/index.js";
import { useSeededDatabase } from "../../../testing/index.js";
import { moderationHarness } from "./test-harness.js";
const db = useSeededDatabase("services");
const serialized = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
describe("real moderation job settlement", () => {
  it.each(["pass", "review", "block"] as const)(
    "CI image %s records one safe event and duplicate run is inert",
    async (verdict) => {
      const labels = verdict === "pass" ? ["Normal"] : ["Porn"];
      const h = await moderationHarness(db, {
        provider: (base) => ({
          ...base,
          audit: async () => {
            assertNotInTransaction("media.audit");
            return ok({ verdict, processed: true, labels });
          },
        }),
      });
      const file = await h.file(),
        job = await h.job(file, "audit_image");
      await Promise.all([h.media.promote({ jobId: job.id }), h.media.promote({ jobId: job.id })]);
      expect(await h.currentFile(file.id)).toMatchObject({
        moderationState: verdict,
        moderationDetail: { channel: "ci", verdict, labels },
      });
      expect(await h.currentJob(job.id)).toMatchObject({ state: "succeeded", attemptNo: 1 });
      expect(await h.conclusions(file.id)).toMatchObject([
        { payload: { v: 1, fileId: file.id, moderationState: verdict } },
      ]);
      expect(await h.conclusions(file.id)).toHaveLength(1);
      await h.media.promote({ jobId: job.id });
      expect(await h.conclusions(file.id)).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "unconfigured/processed-false image stays pending (%s)",
    async (processed) => {
      const h = await moderationHarness(db, {
        provider: (base) => ({
          ...base,
          audit: async () =>
            processed
              ? failed("unconfigured", "fictional unavailable")
              : ok({ verdict: "pass", processed: false }),
        }),
      });
      const file = await h.file(),
        job = await h.job(file, "audit_image");
      await h.media.promote({ jobId: job.id });
      expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pending");
      expect(await h.currentJob(job.id)).toMatchObject({
        state: "failed",
        errorCode: "CI_IMAGE_UNAVAILABLE",
      });
      expect(await h.conclusions(file.id)).toEqual([]);
    },
  );
  it("real bounded UTF8 bytes are audited outside TX, original text never persists", async () => {
    const text = "虚构转写：13800138000",
      auditText = vi.fn(async () => {
        assertNotInTransaction("media.auditText");
        return ok({ verdict: "review" as const, processed: true, labels: ["Porn"] });
      });
    const h = await moderationHarness(db, { provider: (base) => ({ ...base, auditText }) });
    const file = await h.file("txt", "store_asset", new TextEncoder().encode(text)),
      job = await h.job(file, "audit_text");
    await h.media.promote({ jobId: job.id });
    expect(auditText).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "review");
    expect(serialized(await h.currentJob(job.id))).not.toContain(text);
    expect(serialized(await h.conclusions(file.id))).not.toContain("13800138000");
  });
  it("audio/doc cannot fake extraction; genuine same-scope text artifact can be supplied later", async () => {
    const h = await moderationHarness(db),
      file = await h.file("mp3"),
      missing = await h.job(file, "audit_text");
    await h.media.promote({ jobId: missing.id });
    expect(await h.currentJob(missing.id)).toMatchObject({
      state: "failed",
      errorCode: "TEXT_NOT_EXTRACTED",
    });
    expect(h.fake.media.callsOf("auditText")).toHaveLength(0);
    const text = await h.file("txt", "store_asset", new TextEncoder().encode("真正存储的虚构转写"));
    const id = await h.tx.run((tx) =>
      h.media.enqueueExtractedTextAudit(tx, { fileId: file.id, textFileId: text.id }),
    );
    await h.media.promote({ jobId: id });
    expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pass");
    const foreignStore = await h.make.store({ entityId: h.entity.id });
    const foreign = await h.file(
      "txt",
      "store_asset",
      new TextEncoder().encode("虚构外店转写"),
      foreignStore.id,
    );
    const doc = await h.file("pdf");
    await expect(
      h.tx.run((tx) =>
        h.media.enqueueExtractedTextAudit(tx, { fileId: doc.id, textFileId: foreign.id }),
      ),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  });
  it("invalid UTF8 and oversized real text are not truncated into a pass", async () => {
    for (const body of [
      new Uint8Array([0xff, 0xfe]),
      new TextEncoder().encode("字".repeat(10001)),
    ]) {
      const h = await moderationHarness(db),
        file = await h.file("txt", "store_asset", body),
        job = await h.job(file, "audit_text");
      await h.media.promote({ jobId: job.id });
      expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pending");
      expect(h.fake.media.callsOf("auditText")).toHaveLength(0);
    }
  });
  it("video submits once then confirms exact job/DataId; unknown submission never resends", async () => {
    const h = await moderationHarness(db),
      file = await h.file("mp4"),
      job = await h.job(file, "audit_video");
    await h.media.promote({ jobId: job.id });
    expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pending");
    expect(await h.currentJob(job.id)).toMatchObject({
      state: "submitted",
      externalJobId: "fake-audit-1",
    });
    h.clock.advance(60_001);
    await h.media.promote({ jobId: job.id });
    expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pass");
    expect(h.fake.media.callsOf("auditVideo")).toHaveLength(1);
    const unknown = await moderationHarness(db, {
      provider: (base) => ({
        ...base,
        auditVideo: async () => failed("unavailable", "submit unknown"),
      }),
    });
    const file2 = await unknown.file("mp4"),
      job2 = await unknown.job(file2, "audit_video");
    await unknown.media.promote({ jobId: job2.id });
    unknown.clock.advance(120_001);
    await unknown.media.promote({ jobId: job2.id });
    expect(await unknown.currentJob(job2.id)).toMatchObject({ state: "submitting", attemptNo: 1 });
    expect(await unknown.conclusions(file2.id)).toEqual([]);
  });
  it("cancel/delete and changed etag during real provider IO discard the late pass", async () => {
    for (const mutate of ["deleted", "etag"] as const) {
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        entered = new Promise<void>((resolve) => {
          started = resolve;
        });
      const h = await moderationHarness(db, {
        provider: (base) => ({
          ...base,
          audit: async () => {
            started();
            await gate;
            return ok({ verdict: "pass", processed: true });
          },
        }),
      });
      const file = await h.file(),
        job = await h.job(file, "audit_image"),
        run = h.media.promote({ jobId: job.id });
      await entered;
      try {
        await h.tx.run(async (tx) => {
          await lockRows(tx, "file_object", [file.id]);
          await tx.fileObject.update({
            where: { id: file.id },
            data:
              mutate === "deleted"
                ? { status: "deleted", deletedAt: h.clock.now() }
                : { etag: "new-generation" },
          });
        });
      } finally {
        release();
      }
      await run;
      expect(await h.currentJob(job.id)).toHaveProperty("state", "canceled");
      expect(await h.conclusions(file.id)).toEqual([]);
    }
  });
  it("a conclusion and its outbox event roll back together when emit fails", async () => {
    const h = await moderationHarness(db, {
      events: (base) => ({
        ...base,
        emit: async (...args) => {
          await base.emit(...args);
          throw new Error("fictional emit rollback");
        },
      }),
    });
    const file = await h.file(),
      job = await h.job(file, "audit_image");
    await expect(h.media.promote({ jobId: job.id })).rejects.toThrow("fictional emit rollback");
    expect(await h.currentFile(file.id)).toHaveProperty("moderationState", "pending");
    expect(await h.currentJob(job.id)).toHaveProperty("state", "running");
    expect(await h.conclusions(file.id)).toEqual([]);
  });
  it("all three new Provider primitives reject a real TX before invoking the fake", async () => {
    const h = await moderationHarness(db),
      src = { bucket: "asset" as const, key: "test/fictional.mp4" },
      userData = "019acdef-0000-7000-8000-000000000000:1";
    await expect(
      h.tx.run(() => h.fake.media.auditText({ bucket: "asset", text: "虚构正文", userData })),
    ).rejects.toThrow();
    await expect(h.tx.run(() => h.fake.media.auditVideo({ src, userData }))).rejects.toThrow();
    await expect(
      h.tx.run(() => h.fake.media.describeAudit({ src, jobId: "fictional-audit", userData })),
    ).rejects.toThrow();
    for (const method of ["auditText", "auditVideo", "describeAudit"] as const)
      expect(h.fake.media.callsOf(method)).toEqual([]);
  });
});
