import { afterEach } from "vitest";
import { createIdentityContext, createTxRunner, uuidv7 } from "../../../kernel/index.js";
import { createEvents } from "../../../events/index.js";
import type { Events } from "../../../events/index.js";
import { createMedia } from "../../index.js";
import type { MediaActor } from "../../index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
} from "../../../testing/index.js";
import type { useSeededDatabase } from "../../../testing/index.js";
import { ok } from "../../../providers/types.js";
import type { MediaProvider } from "../../../providers/types.js";
const owned: ReturnType<typeof createMedia>[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((media) => media.jobs.shutdown()));
});
/** These explicit stored file rows exercise moderation; they are not codec/production-check fixtures. */
export async function moderationHarness(
  handle: ReturnType<typeof useSeededDatabase>,
  options: {
    wx?: boolean;
    provider?: (media: MediaProvider) => MediaProvider;
    events?: (events: Events) => Events;
  } = {},
) {
  const db = await handle.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma: db, appEnv: "test" });
  const make = createFactories({ db, clock }),
    fake = createFakeProviders({ clock }),
    assembly = assembleForTest({ entry: "worker" });
  const user = await make.merchantUser(),
    entity = await make.entity({ createdByUserId: user.id }),
    store = await make.store({ entityId: entity.id });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
    entityId: entity.id,
    storeId: store.id,
  });
  const actor: MediaActor = {
    identity: ctx,
    merchant: { standing: "owner", entityId: entity.id, storeId: store.id },
  };
  const baseEvents = createEvents({ assembly, clock, tx }),
    events = options.events?.(baseEvents) ?? baseEvents;
  const provider = options.provider?.(fake.media) ?? fake.media;
  const media = createMedia({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    moderation: provider,
    pollMs: 0,
    ...(options.wx
      ? {
          wechatImage: {
            appid: "wx_public_fake",
            provider: {
              configured: true,
              checkImage: async () => ok({ verdict: "pending" as const, traceId: uuidv7() }),
            },
            fallback: provider,
            recentWechatOpenid: async () => ({
              wechatIdentityId: uuidv7(),
              openid: "public-fake-openid",
            }),
          },
        }
      : {}),
  });
  owned.push(media);
  async function file(
    ext = "png",
    category = "store_asset",
    body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    storeId = store.id,
  ) {
    const id = uuidv7(),
      ref = { bucket: "asset" as const, key: `test/${id}.${ext}` };
    fake.storage.put(ref, body, ext === "txt" ? "text/plain" : "application/octet-stream");
    const head = await fake.storage.head(ref);
    if (!head.ok || !head.value.exists) throw new Error("test object missing");
    const row = await make.fileObject({
      id,
      bucket: ref.bucket,
      objectKey: ref.key,
      category,
      ext,
      scopeType: "store",
      entityId: entity.id,
      storeId,
      uploadActorType: "merchant",
      uploadActorId: user.id,
      uploadClient: "weapp",
      etag: head.value.etag,
      declaredSize: body.length,
      sizeBytes: body.length,
      declaredMime: "application/octet-stream",
      mime: "application/octet-stream",
      moderationState: "pending",
    });
    return row;
  }
  async function job(
    file: Awaited<ReturnType<typeof make.fileObject>>,
    kind: "audit_image" | "audit_video" | "audit_text",
    textFile?: Awaited<ReturnType<typeof make.fileObject>>,
  ) {
    const now = clock.now(),
      text = textFile ?? (file.ext === "txt" ? file : undefined),
      dedupeKey = `${kind}:${file.id}:${text && text.id !== file.id ? `text:${text.id}` : "v1"}`;
    return db.mediaJob.create({
      data: {
        id: uuidv7(),
        kind,
        mode: kind === "audit_video" ? "remote" : "local",
        provider: provider.status,
        subjectType: "file_object",
        subjectId: file.id,
        state: "queued",
        dedupeKey,
        input: {
          src: { bucket: file.bucket, key: file.objectKey, etag: file.etag },
          scenes: ["profile"],
          ...(text
            ? {
                textSource: {
                  fileId: text.id,
                  bucket: text.bucket,
                  key: text.objectKey,
                  etag: text.etag,
                  sizeBytes: text.sizeBytes!.toString(),
                },
              }
            : {}),
        },
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + 30 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  const currentFile = (id: string) => db.fileObject.findUniqueOrThrow({ where: { id } });
  const currentJob = (id: string) => db.mediaJob.findUniqueOrThrow({ where: { id } });
  const conclusions = (id: string) =>
    db.outboxEvent.findMany({ where: { eventType: "file.moderated", aggregateId: id } });
  return {
    db,
    clock,
    tx,
    make,
    fake,
    media,
    assembly,
    events,
    actor,
    ctx,
    user,
    entity,
    store,
    file,
    job,
    currentFile,
    currentJob,
    conclusions,
  };
}
