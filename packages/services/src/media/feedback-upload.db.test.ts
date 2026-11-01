import { afterEach, expect, it } from "vitest";
import { createEvents } from "../events/index.js";
import { ownTaskScope } from "../authz/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia } from "./index.js";
import type { Media, MediaActor, RegisterInput } from "./index.js";

const handle = useSeededDatabase("services", { max: 1 });
let media: Media | undefined;
afterEach(async () => {
  await media?.jobs.shutdown();
  media = undefined;
});

it("代录截图真实上传入库仅属本人门店；权限、身份、范围和商家代传拒绝零写", async () => {
  const db = await handle.prisma(),
    clock = createClock(),
    make = createFactories({ db, clock });
  const tx = createTxRunner({ prisma: db, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" });
  const fake = createFakeProviders({ clock });
  const files = createMedia({
    tx,
    assembly,
    clock,
    events: createEvents({ tx, assembly, clock }),
    storage: fake.storage,
    pollMs: 0,
  });
  media = files;
  const manager = await make.staff({ staffRoleKey: "delivery_manager" });
  const other = await make.staff({ staffRoleKey: "super_admin" });
  const editor = await make.staff({ staffRoleKey: "editor" });
  const entity = await make.entity(),
    store = await make.store({ entityId: entity.id, deliveryManagerId: manager.id });
  const foreign = await make.entity(),
    foreignStore = await make.store({ entityId: foreign.id });
  const staff = await sampleStaffContext(db, manager.id);
  const actor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: manager.id, client: "admin" } }),
    staff: { ...staff, scope: ownTaskScope(staff.staff) },
  };
  const otherActor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: other.id, client: "admin" } }),
    staff: await sampleStaffContext(db, other.id),
  };
  const editorActor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: editor.id, client: "admin" } }),
    staff: await sampleStaffContext(db, editor.id),
  };
  const input: RegisterInput = {
    category: "ticket_attachment",
    storeId: store.id,
    entityId: entity.id,
    files: [{ fileName: "feedback.png", sizeBytes: "8", clientToken: uuidv7() }],
  };
  const before = await snapshotTables(db, [
    "file_object",
    "media_job",
    "audit_log",
    "outbox_event",
  ]);
  for (const rejected of [
    editorActor,
    { ...actor, identity: otherActor.identity },
    {
      ...actor,
      staff: { ...actor.staff!, moduleLevels: { ...staff.moduleLevels, delivery: "n" as const } },
    },
  ])
    await expect(files.register(rejected, input)).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
  await expect(files.register(actor, { ...input, storeId: foreignStore.id })).rejects.toMatchObject(
    { error: "NOT_FOUND" },
  );
  await expect(files.register(actor, { ...input, entityId: foreign.id })).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  await expect(files.register(actor, { ...input, storeId: undefined })).rejects.toMatchObject({
    error: "VALIDATION_FAILED",
  });
  await expect(files.register(actor, { ...input, onBehalfStore: true })).rejects.toMatchObject({
    error: "FILE_CATEGORY_NOT_ALLOWED",
  });
  expect(
    await snapshotTables(db, ["file_object", "media_job", "audit_log", "outbox_event"]),
  ).toEqual(before);
  await expect(
    files.register(actor, { ...input, licenseKind: "business_license" }),
  ).rejects.toMatchObject({ error: "FILE_CATEGORY_NOT_ALLOWED" });
  await expect(
    files.register(actor, {
      ...input,
      production: { kind: "ad", adId: uuidv7(), aiUsage: { used: false, tools: [] } },
    }),
  ).rejects.toMatchObject({ error: "FILE_CATEGORY_NOT_ALLOWED" });
  expect(
    await snapshotTables(db, ["file_object", "media_job", "audit_log", "outbox_event"]),
  ).toEqual(before);
  expect(fake.storage.callsOf("presignPost")).toHaveLength(0);

  const grant = (await files.register(actor, input)).items[0]!;
  const registered = await snapshotTables(db, [
    "file_object",
    "media_job",
    "audit_log",
    "outbox_event",
  ]);
  expect((await files.register(actor, input)).items[0]!.fileId).toBe(grant.fileId);
  expect(
    await snapshotTables(db, ["file_object", "media_job", "audit_log", "outbox_event"]),
  ).toEqual(registered);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fake.storage.put({ bucket: "asset", key: grant.key }, bytes, "image/png");
  await files.completeAdmin(actor, grant.fileId);
  const job = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${grant.fileId}` },
  });
  await files.promote({ jobId: job.id });
  expect(await db.fileObject.findUniqueOrThrow({ where: { id: grant.fileId } })).toMatchObject({
    status: "stored",
    category: "ticket_attachment",
    scopeType: "store",
    entityId: entity.id,
    storeId: store.id,
    uploadActorType: "staff",
    uploadActorId: manager.id,
    uploadClient: "admin",
    onBehalfStoreId: null,
  });
  const meta = { requestId: null, ip: null, userAgent: null, sessionId: null, authMethod: null };
  const signed = await files.downloadUrls(actor, { fileId: grant.fileId }, meta);
  expect(fake.storage.fetch(signed.url)).toMatchObject({ status: 200, body: bytes });
  const signsBefore = fake.storage.callsOf("presignGet").length;
  for (const rejected of [
    otherActor,
    editorActor,
    {
      ...actor,
      staff: { ...actor.staff!, permissions: new Set([...staff.permissions].filter(() => false)) },
    },
  ])
    await expect(
      files.downloadUrls(rejected, { fileId: grant.fileId }, meta),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect(fake.storage.callsOf("presignGet")).toHaveLength(signsBefore);
}, 30_000);
