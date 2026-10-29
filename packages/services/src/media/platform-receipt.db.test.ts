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
import { createMedia } from "./index.js";
import type { Media, MediaActor, RegisterInput } from "./index.js";
const handle = useSeededDatabase("services", { max: 1 });
let media: Media | undefined;
afterEach(async () => {
  await media?.jobs.shutdown();
  media = undefined;
});
async function setup() {
  await handle.reset();
  const db = await handle.prisma(),
    clock = createClock(),
    make = createFactories({ db, clock }),
    tx = createTxRunner({ prisma: db, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    fake = createFakeProviders({ clock });
  const files = createMedia({
    tx,
    assembly,
    clock,
    events: createEvents({ tx, assembly, clock }),
    storage: fake.storage,
    pollMs: 0,
  });
  media = files;
  const person = await make.staff({ staffRoleKey: "finance" }),
    staff = await sampleStaffContext(db, person.id, { stepUpAt: clock.now() }),
    role = await db.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
  const actor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: person.id, client: "admin" } }),
    staff,
  };
  function limited(scope: "own" | "group" | "all", actions: Record<string, { on: boolean }>) {
    return {
      ...actor,
      staff: buildStaffContext({
        staff: staff.staff,
        role: normalizeRoleConfig("finance", {
          ...role,
          dataScope: scope,
          actions: { ...normalizeRoleConfig("finance", role).actions, ...actions },
        }),
        groupStaffIds: [],
        stepUpAt: clock.now(),
      }),
    };
  }
  const input = (): RegisterInput => ({
    category: "pay_receipt",
    files: [{ fileName: "fictional-platform-receipt.png", sizeBytes: "8", clientToken: uuidv7() }],
  });
  return { db, clock, make, files, fake, actor, limited, input };
}
it("平台回单仅all且原回单权限加退款或对账处理权限；错身份、scope、MFA和发票零写拒绝", async () => {
  const h = await setup(),
    base = await snapshotTables(h.db, ["file_object", "media_job", "audit_log", "outbox_event"]);
  const cases: [MediaActor, RegisterInput, string][] = [
    [h.limited("own", {}), h.input(), "NOT_FOUND"],
    [h.limited("group", {}), h.input(), "NOT_FOUND"],
    [
      h.limited("all", {
        "finance.refund.execute": { on: false },
        "finance.recon.resolve": { on: false },
      }),
      h.input(),
      "PERMISSION_DENIED",
    ],
    [
      h.limited("all", { "finance.receipt.confirm": { on: false } }),
      h.input(),
      "PERMISSION_DENIED",
    ],
    [{ ...h.actor, staff: { ...h.actor.staff!, stepUpAt: null } }, h.input(), "STEP_UP_REQUIRED"],
    [
      {
        ...h.actor,
        identity: createIdentityContext({
          actor: { type: "staff", id: uuidv7(), client: "admin" },
        }),
      },
      h.input(),
      "PERMISSION_DENIED",
    ],
    [h.actor, { ...h.input(), category: "invoice" }, "VALIDATION_FAILED"],
    [h.actor, { ...h.input(), onBehalfStore: true }, "FILE_CATEGORY_NOT_ALLOWED"],
  ];
  for (const [actor, input, error] of cases)
    await expect(h.files.register(actor, input)).rejects.toMatchObject({ error });
  expect(
    await snapshotTables(h.db, ["file_object", "media_job", "audit_log", "outbox_event"]),
  ).toEqual(base);
  expect(h.fake.storage.callsOf("presignPost")).toHaveLength(0);
});
it("退款与对账角色均走实际登记、complete、promote得到本人secure平台回单；另一人不能完成", async () => {
  const h = await setup(),
    other = await h.make.staff({ staffRoleKey: "finance" }),
    otherActor: MediaActor = {
      identity: createIdentityContext({ actor: { type: "staff", id: other.id, client: "admin" } }),
      staff: await sampleStaffContext(h.db, other.id, { stepUpAt: h.clock.now() }),
    };
  for (const actor of [
    h.limited("all", { "finance.recon.resolve": { on: false } }),
    h.limited("all", { "finance.refund.execute": { on: false } }),
  ]) {
    const grant = (await h.files.register(actor, h.input())).items[0]!;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    h.fake.storage.put({ bucket: "secure", key: grant.key }, bytes, "image/png");
    await expect(h.files.complete(otherActor, grant.fileId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await h.files.complete(actor, grant.fileId);
    const job = await h.db.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${grant.fileId}` },
    });
    await h.files.promote({ jobId: job.id });
    expect(await h.db.fileObject.findUniqueOrThrow({ where: { id: grant.fileId } })).toMatchObject({
      scopeType: "platform",
      entityId: null,
      storeId: null,
      onBehalfStoreId: null,
      category: "pay_receipt",
      bucket: "secure",
      status: "stored",
      uploadActorType: "staff",
      uploadActorId: actor.staff!.staff.id,
      sizeBytes: 8n,
    });
    expect((await h.db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "succeeded",
    );
    const signs = h.fake.storage.callsOf("presignGet").length;
    const meta = { requestId: null, ip: null, userAgent: null, sessionId: null, authMethod: null };
    for (const scope of ["own", "group"] as const) {
      // 同一上传人降级也不能通过getAdmin优先owned的分支绕过平台回单范围。
      const restricted = h.limited(scope, {});
      await expect(h.files.getAdmin(restricted, grant.fileId)).rejects.toMatchObject({
        error: "NOT_FOUND",
      });
      await expect(
        h.files.downloadUrls(restricted, { fileId: grant.fileId }, meta),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
    }
    expect(h.fake.storage.callsOf("presignGet")).toHaveLength(signs);
    expect(await h.files.getAdmin(actor, grant.fileId)).toMatchObject({
      fileId: grant.fileId,
      status: "stored",
    });
    const signed = await h.files.downloadUrls(actor, { fileId: grant.fileId }, meta);
    expect(h.fake.storage.fetch(signed.url)).toMatchObject({ status: 200, body: bytes });
  }
});
