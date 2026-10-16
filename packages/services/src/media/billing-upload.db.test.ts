import { afterEach, expect, it } from "vitest";
import { createEvents } from "../events/index.js";
import { buildStaffContext, normalizeRoleConfig } from "../authz/index.js";
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
import { createMedia, placeholderPdf } from "./index.js";
import type { Media, MediaActor, RegisterInput } from "./index.js";

const handle = useSeededDatabase("services", { max: 1 });
let media: Media | undefined;
afterEach(async () => {
  await media?.jobs.shutdown();
  media = undefined;
});

it("财务回单与发票真实上传入库；权限、员工身份与主体/门店范围拒绝零写", async () => {
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
  const finance = await make.staff({ staffRoleKey: "finance" }),
    otherStaff = await make.staff({ staffRoleKey: "delivery_manager" });
  const entity = await make.entity(),
    store = await make.store({ entityId: entity.id, deliveryManagerId: finance.id });
  const foreign = await make.entity(),
    foreignStore = await make.store({ entityId: foreign.id });
  const staff = await sampleStaffContext(db, finance.id, { stepUpAt: clock.now() });
  const actor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: finance.id, client: "admin" } }),
    staff,
  };
  const outsider: MediaActor = {
    identity: createIdentityContext({
      actor: { type: "staff", id: otherStaff.id, client: "admin" },
    }),
    staff: await sampleStaffContext(db, otherStaff.id, { stepUpAt: clock.now() }),
  };
  const role = await db.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
  const limited: MediaActor = {
    ...actor,
    staff: buildStaffContext({
      staff: staff.staff,
      role: normalizeRoleConfig("finance", { ...role, dataScope: "own" }),
      groupStaffIds: [],
      stepUpAt: clock.now(),
    }),
  };
  const input = (
    category: "invoice" | "pay_receipt",
    scope: Pick<RegisterInput, "entityId" | "storeId">,
  ): RegisterInput => ({
    category,
    ...scope,
    files: [
      {
        fileName: category === "invoice" ? "invoice.pdf" : "receipt.png",
        sizeBytes: String(category === "invoice" ? placeholderPdf("BILLING-UPLOAD").byteLength : 8),
        clientToken: uuidv7(),
      },
    ],
  });
  const invoice = input("invoice", { entityId: entity.id });
  const receipt = input("pay_receipt", { entityId: entity.id, storeId: store.id });
  const before = await snapshotTables(db, [
    "file_object",
    "media_job",
    "audit_log",
    "outbox_event",
  ]);
  for (const candidate of [invoice, receipt])
    await expect(files.register(outsider, candidate)).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
  await expect(
    files.register({ ...actor, identity: outsider.identity }, invoice),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  await expect(
    files.register(limited, input("invoice", { entityId: foreign.id })),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    files.register(actor, input("invoice", { entityId: entity.id, storeId: foreignStore.id })),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(files.register(actor, { ...invoice, onBehalfStore: true })).rejects.toMatchObject({
    error: "FILE_CATEGORY_NOT_ALLOWED",
  });
  await expect(
    files.register({ ...actor, staff: { ...staff, stepUpAt: null } }, receipt),
  ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
  expect(
    await snapshotTables(db, ["file_object", "media_job", "audit_log", "outbox_event"]),
  ).toEqual(before);
  expect(fake.storage.callsOf("presignPost")).toHaveLength(0);
  const cs = await make.staff({ staffRoleKey: "cs" });
  const customerService: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: cs.id, client: "admin" } }),
    staff: await sampleStaffContext(db, cs.id),
  };
  const editor = await make.staff({ staffRoleKey: "editor" });
  const editorContext = await sampleStaffContext(db, editor.id);
  const editorRole = await db.staffRole.findUniqueOrThrow({ where: { key: "editor" } });
  const noReadPermission: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: editor.id, client: "admin" } }),
    staff: buildStaffContext({
      staff: editorContext.staff,
      role: normalizeRoleConfig("editor", { ...editorRole, dataScope: "all" }),
      groupStaffIds: [],
      stepUpAt: null,
    }),
  };
  const meta = { requestId: null, ip: null, userAgent: null, sessionId: null, authMethod: null };
  for (const candidate of [invoice, receipt]) {
    const grant = (await files.register(limited, candidate)).items[0]!;
    const bytes =
      candidate.category === "invoice"
        ? placeholderPdf("BILLING-UPLOAD")
        : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mime = candidate.category === "invoice" ? "application/pdf" : "image/png";
    fake.storage.put({ bucket: "secure", key: grant.key }, bytes, mime);
    await files.complete(limited, grant.fileId);
    const job = await db.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${grant.fileId}` },
    });
    await files.promote({ jobId: job.id });
    expect(await db.fileObject.findUniqueOrThrow({ where: { id: grant.fileId } })).toMatchObject({
      status: "stored",
      category: candidate.category,
      scopeType: "entity",
      entityId: entity.id,
      storeId: null,
      onBehalfStoreId: null,
      uploadActorType: "staff",
      uploadActorId: finance.id,
      bucket: "secure",
      mime,
      sizeBytes: BigInt(bytes.byteLength),
    });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "succeeded",
    );
    if (candidate.category === "invoice") {
      const signed = await files.downloadUrls(limited, { fileId: grant.fileId }, meta);
      expect(fake.storage.fetch(signed.url)).toMatchObject({ status: 200, body: bytes });
      expect(Date.parse(signed.expiresAt) - clock.now().getTime()).toBe(300_000);
      const serviceSigned = await files.downloadUrls(
        customerService,
        { fileId: grant.fileId },
        meta,
      );
      expect(fake.storage.fetch(serviceSigned.url)).toMatchObject({ status: 200, body: bytes });
      expect(
        await db.auditLog.count({ where: { targetId: grant.fileId, action: "files.url.sign" } }),
      ).toBe(2);
      const refusedBefore = await snapshotTables(db, [
        "file_object",
        "media_job",
        "audit_log",
        "outbox_event",
      ]);
      const signsBefore = fake.storage.callsOf("presignGet").length;
      // Editor has all data scope but no finance/service view; the manager has
      // service view but no visible store in this entity. Both remain NOT_FOUND.
      await expect(
        files.downloadUrls(noReadPermission, { fileId: grant.fileId }, meta),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
      await expect(
        files.downloadUrls(outsider, { fileId: grant.fileId }, meta),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
      expect(
        await snapshotTables(db, ["file_object", "media_job", "audit_log", "outbox_event"]),
      ).toEqual(refusedBefore);
      expect(fake.storage.callsOf("presignGet")).toHaveLength(signsBefore);
    }
  }
  // A supplied store is optional for these entity files, and must not become a store scope.
  const fromStore = (await files.register(actor, input("pay_receipt", { storeId: store.id })))
    .items[0]!;
  expect(await db.fileObject.findUniqueOrThrow({ where: { id: fromStore.fileId } })).toMatchObject({
    scopeType: "entity",
    entityId: entity.id,
    storeId: null,
  });
  const redOnly: MediaActor = {
    ...actor,
    staff: buildStaffContext({
      staff: staff.staff,
      role: normalizeRoleConfig("finance", {
        ...role,
        dataScope: "own",
        actions: {
          ...normalizeRoleConfig("finance", role).actions,
          "finance.invoice.issue": { on: false },
          "finance.invoice.red": { on: true },
        },
      }),
      groupStaffIds: [],
      stepUpAt: clock.now(),
    }),
  };
  expect(redOnly.staff!.permissions.has("finance.invoice.issue")).toBe(false);
  expect(redOnly.staff!.permissions.has("finance.invoice.red")).toBe(true);
  const red = (await files.register(redOnly, input("invoice", { entityId: entity.id }))).items[0]!;
  expect(await db.fileObject.findUniqueOrThrow({ where: { id: red.fileId } })).toMatchObject({
    scopeType: "entity",
    entityId: entity.id,
    uploadActorId: finance.id,
  });
}, 30_000);
