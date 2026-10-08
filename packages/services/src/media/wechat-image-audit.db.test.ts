import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { createEvents } from "../events/index.js";
import {
  createIdentityContext,
  createTxRunner,
  uuidv7,
  defineRegistration,
  implementKeyed,
  type Tx,
} from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia, fileRefTypePort } from "./index.js";
import type { MediaActor } from "./index.js";
import { ok } from "../providers/types.js";
import type { WechatProvider, MediaProvider } from "../providers/types.js";

const db = useSeededDatabase("services");
const clock = createClock();
const fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let tx: ReturnType<typeof createTxRunner>;
let media: ReturnType<typeof createMedia>;
let actor: MediaActor;
const wake = vi.fn(async () => {});
const recent = vi.fn(
  async (
    _tx: Tx,
    _input: { merchantUserId: string; appid: string; now: Date },
  ): Promise<{ wechatIdentityId: string; openid: string } | null> => ({
    wechatIdentityId: uuidv7(),
    openid: "FAKE_OPENID",
  }),
);
const pending: WechatProvider["checkImage"] = async (input) => {
  const actual = await fake.wechat.checkImage(input);
  return actual.ok ? ok({ verdict: "pending", traceId: uuidv7() }) : actual;
};
const processed: MediaProvider["audit"] = async (input) => fake.media.audit(input);
const check = vi.fn(pending);
const audit = vi.fn(processed);
beforeEach(() => {
  check.mockClear().mockImplementation(pending);
  audit.mockClear().mockImplementation(processed);
  recent.mockClear().mockResolvedValue({ wechatIdentityId: uuidv7(), openid: "FAKE_OPENID" });
  wake.mockClear();
});
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id });
  actor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store.id,
    }),
    merchant: { standing: "owner", entityId: entity.id, storeId: store.id },
  };
  const assembly = assembleForTest({
    entry: "worker",
    extra: [
      defineRegistration("lyxtest_wximage", {
        portImplementations: [
          implementKeyed(fileRefTypePort, "store_profile", {
            roles: { logo: { categories: ["profile_image"], retentionDays: 30 } },
          }),
        ],
      }),
    ],
  });
  const events = createEvents({ assembly, clock, tx });
  const extra = {
    wechatImage: {
      appid: "wx_media_fake",
      provider: { configured: true, checkImage: check },
      fallback: { status: "fake" as const, audit },
      recentWechatOpenid: recent,
    },
  };
  media = createMedia({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    pollMs: 0,
    channel: { enqueue: wake },
    ...extra,
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma?.$disconnect();
});
async function stored(category: "profile_image" | "pay_receipt" = "profile_image") {
  const file = (
    await media.register(actor, {
      category,
      files: [{ fileName: "own.png", sizeBytes: String(image.length), clientToken: uuidv7() }],
    })
  ).items[0]!;
  fake.storage.put({ bucket: "asset", key: file.key }, image, "image/png");
  if (category === "pay_receipt")
    fake.storage.put({ bucket: "secure", key: file.key }, image, "image/png");
  await media.complete(actor, file.fileId);
  const promote = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await media.promote({ jobId: promote.id });
  return file.fileId;
}
it("production stored promotion creates WX job and pending moderation", async () => {
  const id = await stored();
  const job = await prisma.mediaJob.findUnique({ where: { dedupeKey: `audit_image_wx:${id}:v1` } });
  expect(job).toMatchObject({
    kind: "audit_image_wx",
    state: "queued",
    subjectId: id,
    attemptNo: 0,
  });
  expect(await prisma.fileObject.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: "stored",
    moderationState: "pending",
  });
});

async function wxJob(fileId: string) {
  return prisma.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `audit_image_wx:${fileId}:v1` } });
}
async function submit(fileId: string) {
  const job = await wxJob(fileId);
  await media.promote({ jobId: job.id });
  return prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
}
const result = (traceId: string, suggest: "pass" | "review" | "risky" = "pass") =>
  tx.run((handle) =>
    media.applyWechatImageResult(
      handle,
      {
        traceId,
        result: { suggest, label: 20001 },
        receivedAt: clock.now(),
      },
      actor.identity,
    ),
  );
it("excluded payment receipt retains original promotion without WX audit", async () => {
  const id = await stored("pay_receipt");
  expect(await prisma.mediaJob.count({ where: { subjectId: id, kind: "audit_image_wx" } })).toBe(0);
  expect(await prisma.fileObject.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: "stored",
    moderationState: "none",
  });
});
it("same-AppID recent identity and signed storage feed TX-external submission exactly once", async () => {
  const id = await stored();
  const queued = await wxJob(id);
  await Promise.all([media.promote({ jobId: queued.id }), media.promote({ jobId: queued.id })]);
  const job = await wxJob(id);
  expect(job).toMatchObject({ state: "submitted", attemptNo: 1, leaseOwner: null });
  expect(job.externalJobId).toBeTruthy();
  expect(recent).toHaveBeenCalledOnce();
  expect(recent.mock.calls[0]?.[1]).toMatchObject({
    merchantUserId: actor.identity.actor.id,
    appid: "wx_media_fake",
    now: clock.now(),
  });
  expect(check).toHaveBeenCalledOnce();
  expect(check.mock.calls[0]?.[0]).toMatchObject({ openid: "FAKE_OPENID", scene: "profile" });
  expect(check.mock.calls[0]?.[0].mediaUrl).toContain("https://");
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
});
it.each(["pass", "review", "risky"] as const)(
  "callback %s persists source, decides with clock, and duplicates cannot reverse result",
  async (suggest) => {
    const id = await stored();
    const job = await submit(id);
    const traceId = job.externalJobId!;
    expect(await result(traceId, suggest)).toBe("processed");
    expect(await result(traceId, suggest === "risky" ? "pass" : "risky")).toBe("ignored");
    const verdict = suggest === "risky" ? "block" : suggest;
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id } });
    expect(file).toMatchObject({
      moderationState: verdict,
      moderationDetail: {
        channel: "wechat",
        verdict,
        traceId,
        labels: ["20001"],
        decidedAt: clock.now().toISOString(),
      },
    });
    expect(await wxJob(id)).toMatchObject({
      state: "succeeded",
      output: { suggest, label: 20001, receivedAt: clock.now().toISOString() },
    });
    const link = () =>
      tx.run((handle) =>
        media.link(handle, {
          refType: "store_profile",
          refId: uuidv7(),
          fileId: id,
          role: "logo",
          entityId: actor.merchant!.entityId,
          storeId: actor.merchant!.storeId,
        }),
      );
    if (suggest === "risky") {
      await expect(link()).rejects.toMatchObject({
        error: "FILE_NOT_USABLE",
        details: { reason: "blocked" },
      });
      await expect(media.signRead({ fileId: id })).rejects.toMatchObject({
        error: "FILE_NOT_AVAILABLE",
      });
    } else {
      await link();
      expect((await media.signRead({ fileId: id })).url).toBeTruthy();
    }
  },
);
it("callback arriving before trace commit retries rather than being acknowledged as ignored", async () => {
  const id = await stored();
  const traceId = uuidv7();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  check.mockImplementationOnce(async (input) => {
    await fake.wechat.checkImage(input);
    entered();
    await hold;
    return ok({ verdict: "pending", traceId });
  });
  const job = await wxJob(id);
  const running = media.promote({ jobId: job.id });
  await started;
  try {
    await expect(result(traceId)).rejects.toMatchObject({ error: "BUSY" });
  } finally {
    release();
    await running;
  }
  expect(await result(traceId)).toBe("processed");
});
it("unknown trace and ambiguous trace fail retryably without modifying unrelated file", async () => {
  await expect(result("not-yet-known")).rejects.toMatchObject({ error: "BUSY" });
  const first = await stored();
  const second = await stored();
  const a = await submit(first);
  const b = await submit(second);
  await prisma.mediaJob.update({ where: { id: b.id }, data: { externalJobId: a.externalJobId } });
  await expect(result(a.externalJobId!)).rejects.toMatchObject({ error: "BUSY" });
  expect(
    (await prisma.fileObject.findUniqueOrThrow({ where: { id: first } })).moderationState,
  ).toBe("pending");
  expect(
    (await prisma.fileObject.findUniqueOrThrow({ where: { id: second } })).moderationState,
  ).toBe("pending");
});
it("missing recent identity selects real CI job; processed false never pretends to pass", async () => {
  const id = await stored();
  recent.mockResolvedValueOnce(null);
  const job = await submit(id);
  expect(job).toMatchObject({ state: "failed", errorCode: "WX_IMAGE_IDENTITY_UNAVAILABLE" });
  expect(check).not.toHaveBeenCalled();
  const ci = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `audit_image:${id}:v1` },
  });
  expect(wake).toHaveBeenCalledWith("media_job", expect.any(String), { jobId: ci.id });
  audit.mockImplementationOnce(async (input) => {
    await fake.media.audit(input);
    return ok({ verdict: "pass", processed: false });
  });
  await media.promote({ jobId: ci.id });
  expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: ci.id } })).toMatchObject({
    state: "failed",
    errorCode: "CI_IMAGE_UNAVAILABLE",
    isRetryable: true,
  });
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
});
it("explicit processed CI block closes audit and preserves file usability guards", async () => {
  const id = await stored();
  recent.mockResolvedValueOnce(null);
  await submit(id);
  const ci = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `audit_image:${id}:v1` },
  });
  audit.mockImplementationOnce(async (input) => {
    await fake.media.audit(input);
    return ok({ verdict: "block", processed: true });
  });
  await media.promote({ jobId: ci.id });
  expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: ci.id } })).toMatchObject({
    state: "succeeded",
    output: { verdict: "block" },
  });
  expect(await prisma.fileObject.findUniqueOrThrow({ where: { id } })).toMatchObject({
    moderationState: "block",
    moderationDetail: { channel: "ci", verdict: "block" },
  });
});
it("changed attempt invalidates stale TX-external result", async () => {
  const id = await stored();
  const job = await wxJob(id);
  check.mockImplementationOnce(async (input) => {
    await fake.wechat.checkImage(input);
    await prisma.mediaJob.update({ where: { id: job.id }, data: { attemptNo: { increment: 1 } } });
    return ok({ verdict: "pending", traceId: uuidv7() });
  });
  await media.promote({ jobId: job.id });
  expect(await wxJob(id)).toMatchObject({ state: "submitting", attemptNo: 2, externalJobId: null });
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
});
it("retired or mismatched file ignores late callback without overwriting its decision", async () => {
  const id = await stored();
  const job = await submit(id);
  await prisma.fileObject.update({
    where: { id },
    data: { status: "rejected", rejectReason: "copy_verify_failed", moderationState: "review" },
  });
  expect(await result(job.externalJobId!, "risky")).toBe("ignored");
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "review",
  );
  const other = await stored();
  const next = await submit(other);
  await prisma.mediaJob.update({
    where: { id: next.id },
    data: { input: { src: { bucket: "asset", key: "different-object" } } },
  });
  expect(await result(next.externalJobId!, "risky")).toBe("ignored");
  expect(
    (await prisma.fileObject.findUniqueOrThrow({ where: { id: other } })).moderationState,
  ).toBe("pending");
});
it("submitted timeout is recovered by original scanner and never resends WX", async () => {
  const id = await stored();
  const job = await submit(id);
  clock.advance(35 * 60_000);
  await media.scanPromote();
  expect(wake).toHaveBeenCalledWith("media_job", expect.any(String), { jobId: job.id });
  await media.promote({ jobId: job.id });
  expect(check).toHaveBeenCalledOnce();
  expect(await wxJob(id)).toMatchObject({ state: "failed", errorCode: "WX_IMAGE_TIMEOUT" });
  expect(await result(job.externalJobId!, "risky")).toBe("ignored");
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
  expect(await prisma.mediaJob.count({ where: { dedupeKey: `audit_image:${id}:v1` } })).toBe(1);
});

it("expired lease rejects late submit and recovers without a second WX request", async () => {
  const id = await stored();
  const job = await wxJob(id);
  check.mockImplementationOnce(async (input) => {
    await fake.wechat.checkImage(input);
    clock.advance(2 * 60_000 + 1);
    return ok({ verdict: "pending", traceId: uuidv7() });
  });
  await media.promote({ jobId: job.id });
  expect(await wxJob(id)).toMatchObject({ state: "submitting", attemptNo: 1, externalJobId: null });
  await media.promote({ jobId: job.id });
  expect(check).toHaveBeenCalledOnce();
  expect(await wxJob(id)).toMatchObject({ state: "failed", errorCode: "WX_IMAGE_TIMEOUT" });
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
});

it("other provider, mode and dedupe tasks are not claimed by this narrow consumer", async () => {
  const id = await stored();
  const job = await wxJob(id);
  for (const data of [{ provider: "local" }, { mode: "local" }, { dedupeKey: `other:${job.id}` }]) {
    await prisma.mediaJob.update({
      where: { id: job.id },
      data: { provider: "wechat", mode: "remote", dedupeKey: `audit_image_wx:${id}:v1`, ...data },
    });
    await media.promote({ jobId: job.id });
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "queued",
      attemptNo: 0,
    });
  }
  expect(check).not.toHaveBeenCalled();
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id } })).moderationState).toBe(
    "pending",
  );
});
