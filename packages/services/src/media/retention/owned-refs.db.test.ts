import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvents } from "../../events/index.js";
import {
  createIdempotencyContext,
  createIdentityContext,
  createSessionMutex,
  createTxRunner,
  fileRefTypePort,
  uuidv7,
} from "../../kernel/index.js";
import type { FileRefType } from "../../kernel/index.js";
import {
  assembleForTest,
  configTestStaffBriefs,
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
  signInAsStaff,
  useSeededDatabase,
} from "../../testing/index.js";
import { createMedia } from "../index.js";
import type { ClockBoundFileRefType, Media } from "../index.js";
import type { RetentionActor } from "./options.js";

const db = useSeededDatabase("services", { label: "ownedrefs", max: 1 });
const NOW = new Date("2030-03-01T04:00:00.000Z"),
  OLD = new Date("2026-01-05T04:00:00.000Z"),
  END = new Date("2027-03-01T04:00:00.001Z"),
  DAY = 86_400_000;
const clock = createClock(NOW),
  fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  make: ReturnType<typeof createFactories>,
  tx: ReturnType<typeof createTxRunner>,
  media: Media,
  mutex: ReturnType<typeof createSessionMutex>,
  actor: RetentionActor,
  refTypes: ReadonlyMap<string, FileRefType>;
let sequence = 1;

beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "api" });
  // 与真实media构造相同的静态登记/业务时钟绑定；每次查询仍进入真实TX与拥有者SQL。
  refTypes = new Map(
    [...assembly.portEntries(fileRefTypePort)].map(([key, definition]) => {
      const factory = definition as Partial<ClockBoundFileRefType>;
      return [key, factory.withClock ? factory.withClock(clock) : definition] as const;
    }),
  );
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 1,
    probeMs: 50,
  });
  fake.storage.capabilities.versioning = true;
  media = createMedia({
    tx,
    clock,
    assembly,
    storage: fake.storage,
    events: createEvents({ tx, clock, assembly }),
    retention: {
      sessionMutex: mutex,
      staffBriefs: configTestStaffBriefs,
      alerts: { raise: async () => {} },
    },
  });
  const signed = await signInAsStaff(prisma, { roleKey: "super_admin", now: clock.now() });
  actor = {
    identity: createIdentityContext({
      actor: { type: "staff", id: signed.staff.id, client: "admin" },
    }),
    staff: await sampleStaffContext(prisma, signed.staff.id, { stepUpAt: clock.now() }),
    meta: {
      requestId: "lyxtest-owned-refs",
      sessionId: signed.sessionId,
      authMethod: "password+totp",
      ip: "192.0.2.77",
      userAgent: "lyxtest owned refs",
    },
  };
}, 120_000);
beforeEach(() => {
  clock.set(NOW);
  fake.storage.resetCalls();
});
afterAll(async () => {
  await mutex?.close();
});

const current = (type: string, fileId: string) =>
  tx.run((t) => {
    const definition = refTypes.get(type);
    if (!definition?.inUse) throw new Error(`真实拥有者未登记inUse: ${type}`);
    return definition.inUse(t, fileId);
  });
async function file(input: Parameters<typeof make.fileObject>[0] = {}) {
  const row = await make.fileObject({
    sizeBytes: 8n,
    declaredSize: 8n,
    storedAt: OLD,
    createdAt: OLD,
    ...input,
  });
  fake.storage.put(
    { bucket: row.bucket as "pub" | "asset" | "secure", key: row.objectKey },
    new Uint8Array(8),
    row.mime!,
  );
  return row;
}
async function erase(row: Awaited<ReturnType<typeof file>>) {
  const body = {
    reason: "隔离测试验证拥有者精确在用守卫",
    confirm: { fileId: row.id, category: row.category },
  };
  return media.retention.erase(actor, row.id, body, {
    idem: createIdempotencyContext({
      mode: "required",
      scope: "admin.file.erase",
      key: uuidv7(),
      actor: actor.identity.actor,
      request: { method: "POST", pathParams: { fileId: row.id }, body, storeId: null },
    }),
  });
}
async function blocked(
  row: Awaited<ReturnType<typeof file>>,
  refs: readonly { refType: string; refId: string }[],
) {
  const count = fake.storage.calls.filter((c) => c.method === "eraseVersions").length;
  expect(await prisma.fileRef.count({ where: { fileId: row.id } })).toBe(0);
  await expect(erase(row)).rejects.toMatchObject({
    error: "FILE_IN_USE",
    details: {
      refs: expect.arrayContaining(refs.map(({ refType, refId }) => ({ refType, refId }))),
    },
  });
  expect(fake.storage.calls.filter((c) => c.method === "eraseVersions")).toHaveLength(count);
  expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
    "stored",
  );
  expect(await prisma.auditLog.count({ where: { targetId: row.id } })).toBe(0);
}
async function owner(closed = false) {
  const user = await make.merchantUser({ createdAt: OLD });
  const entity = await make.entity({
    createdByUserId: user.id,
    createdAt: OLD,
    ...(closed ? { lifecycle: "closed", closedAt: END } : {}),
  });
  const store = await make.store({
    entityId: entity.id,
    createdAt: OLD,
    ...(closed
      ? {
          lifecycle: "archived",
          archivedAt: END,
          archiveReason: "entity_closed",
          archiveActorType: "system",
        }
      : {}),
  });
  return { user, entity, store };
}
async function approval(input: {
  kind: "qualification" | "account_change";
  subjectId: string;
  entityId?: string | undefined;
  storeId?: string | undefined;
  userId?: string | undefined;
}) {
  const isQualification = input.kind === "qualification";
  const requesterStaffId = isQualification ? undefined : (await make.staff()).id;
  return prisma.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind: input.kind,
      category: isQualification ? "review" : "approval",
      subjectType: isQualification ? "store" : input.userId ? "merchant_user" : "entity",
      subjectId: input.subjectId,
      entityId: input.entityId,
      storeId: input.storeId,
      requestNo: isQualification ? null : `ZH20260105${String(sequence++).padStart(5, "0")}`,
      status: "approved",
      summarySnapshot: { title: "虚构已决定证据" },
      submitActorType: isQualification ? "merchant" : "staff",
      submitActorId: isQualification ? input.userId : requesterStaffId,
      submitClient: isQualification ? "weapp" : "admin",
      requesterStaffId,
      submittedAt: OLD,
      decidedAt: OLD,
      decidedByStaffId: actor.staff.staff.id,
      dedupeKey: `${input.kind}:${uuidv7()}`,
      createdAt: OLD,
      updatedAt: OLD,
    },
  });
}

describe("W3-06真实拥有者精确引用三组风险", { timeout: 60_000 }, () => {
  it("缺ref的当前原片/播放档位拒删，历史原片及归档店到期三档案不被旧列永久占用", async () => {
    const drama = await make.drama(),
      staffId = actor.staff.staff.id;
    const old = await file({ category: "drama_master" }),
      active = await file({ category: "drama_master" });
    const history = await prisma.dramaEpisodeMaster.create({
      data: {
        id: uuidv7(),
        dramaId: drama.id,
        episodeNo: 1,
        revNo: 1,
        fileId: old.id,
        state: "superseded",
        isCurrent: false,
        createdByStaffId: staffId,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const master = await prisma.dramaEpisodeMaster.create({
      data: {
        id: uuidv7(),
        dramaId: drama.id,
        episodeNo: 1,
        revNo: 2,
        fileId: active.id,
        state: "ready",
        isCurrent: true,
        createdByStaffId: staffId,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    expect(await current("drama_episode_master", active.id)).toEqual([
      { fileId: active.id, refId: master.id, role: "main" },
    ]);
    expect(await current("drama_episode_master", old.id)).toEqual([]);
    expect(
      await prisma.dramaEpisodeMaster.findUnique({ where: { id: history.id } }),
    ).not.toBeNull();
    await blocked(active, [{ refType: "drama_episode_master", refId: master.id }]);
    expect(await erase(old)).toMatchObject({
      status: "deleted",
      erasedAt: clock.now().toISOString(),
    });

    const source = await file({ category: "trailer_src" }),
      rendition = await file({ category: "trailer_out" });
    const playable = await prisma.playableAsset.create({
      data: {
        id: uuidv7(),
        kind: "trailer",
        ownerType: "drama",
        ownerId: drama.id,
        sourceFileId: source.id,
        state: "ready",
        readyAt: OLD,
        specVersion: 1,
        renditions: [
          { quality: "720p", fileId: rendition.id, width: 720, height: 1280, bitrateKbps: 1500 },
        ],
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    expect(await current("playable_asset", rendition.id)).toEqual([
      { fileId: rendition.id, refId: playable.id, role: "rendition" },
    ]);
    await blocked(rendition, [{ refType: "playable_asset", refId: playable.id }]);
    await prisma.playableAsset.update({
      where: { id: playable.id },
      data: { state: "retired", retiredAt: OLD },
    });
    expect(await current("playable_asset", rendition.id)).toEqual([]);

    const o = await owner(),
      image = await file({
        category: "profile_image",
        bucket: "asset",
        scopeType: "store",
        entityId: o.entity.id,
        storeId: o.store.id,
      });
    await prisma.storeProfile.create({
      data: {
        storeId: o.store.id,
        entityId: o.entity.id,
        logoFileId: image.id,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const photo = await prisma.storeProfileMedia.create({
      data: {
        id: uuidv7(),
        storeId: o.store.id,
        entityId: o.entity.id,
        fileId: image.id,
        mediaGroup: "door",
        mediaKind: "image",
        position: 1,
        createActorType: "system",
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const service = await prisma.storeServiceItem.create({
      data: {
        id: uuidv7(),
        storeId: o.store.id,
        entityId: o.entity.id,
        imageFileId: image.id,
        name: "虚构服务",
        priceFen: 100,
        position: 1,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const uses = [
      { refType: "store_profile", refId: o.store.id, role: "logo" },
      { refType: "store_profile_media", refId: photo.id, role: "main" },
      { refType: "store_service_item", refId: service.id, role: "image" },
    ];
    await blocked(image, uses);
    const archivedAt = new Date(NOW.getTime() - 181 * DAY),
      keepUntil = new Date(archivedAt.getTime() + 180 * DAY);
    await prisma.store.update({
      where: { id: o.store.id },
      data: {
        lifecycle: "archived",
        archivedAt,
        archiveReason: "by_owner",
        archiveActorType: "merchant",
        archiveActorId: o.user.id,
        archiveClient: "weapp",
      },
    });
    for (const use of uses) {
      await prisma.fileRef.create({
        data: {
          id: uuidv7(),
          fileId: image.id,
          ...use,
          state: "released",
          releasedAt: archivedAt,
          keepUntil,
          createdAt: OLD,
          updatedAt: archivedAt,
        },
      });
      expect(await current(use.refType, image.id)).toEqual([]);
    }
    const before = await prisma.storeProfile.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(await erase(image)).toMatchObject({
      status: "deleted",
      erasedAt: clock.now().toISOString(),
    });
    expect(await prisma.storeProfile.findUniqueOrThrow({ where: { storeId: o.store.id } })).toEqual(
      before,
    );
  });

  it("已取代送审证照到真实closed三周年才放行，草稿替换不占用而历史协议仍保护", async () => {
    const o = await owner(true),
      license = await file({
        category: "kyc_license",
        bucket: "secure",
        scopeType: "entity",
        entityId: o.entity.id,
      });
    const request = await approval({
      kind: "qualification",
      subjectId: o.store.id,
      entityId: o.entity.id,
      storeId: o.store.id,
      userId: o.user.id,
    });
    const round = await prisma.qualificationSubmission.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        kind: "initial",
        claimedEntityType: "enterprise",
        approvalRequestId: request.id,
        roundNo: 1,
        submittedAt: OLD,
        submittedByUserId: o.user.id,
        proposedStoreName: "虚构门店",
        proposedIndustryCode: "TEST",
        proposedCategoryCode: "TEST01",
        proposedAddressSnapshot: {},
        declarationConfirmedAt: OLD,
        declarationVersion: "test-v1",
        closedAt: OLD,
        outcome: "approved",
        approveMode: "normal",
        createdByUserId: o.user.id,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const doc = await prisma.qualificationDoc.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        qualificationSubmissionId: round.id,
        docType: "business_license",
        scope: "entity",
        fileId: license.id,
        origin: "uploaded",
        verdict: "accepted",
        effectiveAt: OLD,
        supersededAt: new Date(OLD.getTime() + DAY),
        uploadedByUserId: o.user.id,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    const preRemoved = await file({ category: "kyc_license", bucket: "secure" });
    await prisma.qualificationDoc.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        qualificationSubmissionId: round.id,
        docType: "business_license",
        scope: "entity",
        fileId: preRemoved.id,
        origin: "uploaded",
        removedAt: new Date(OLD.getTime() - 1),
        uploadedByUserId: o.user.id,
        createdAt: new Date(OLD.getTime() - DAY),
        updatedAt: OLD,
      },
    });
    expect(await current("qualification_doc", preRemoved.id)).toEqual([]);
    expect(await current("qualification_doc", license.id)).toEqual([
      { fileId: license.id, refId: doc.id, role: "main" },
    ]);
    await blocked(license, [{ refType: "qualification_doc", refId: doc.id }]);
    clock.advance(1);
    expect(await current("qualification_doc", license.id)).toEqual([]);
    expect(await erase(license)).toMatchObject({
      status: "deleted",
      erasedAt: clock.now().toISOString(),
    });

    const pdf = await file({
      category: "legal_doc",
      bucket: "secure",
      ext: "pdf",
      declaredMime: "application/pdf",
      mime: "application/pdf",
    });
    const published = await make.agreementVersion({ status: "superseded", pdfFileId: pdf.id });
    expect(await current("agreement_version", pdf.id)).toEqual([
      { fileId: pdf.id, refId: published.id, role: "pdf" },
    ]);
    await blocked(pdf, [{ refType: "agreement_version", refId: published.id }]);
    const replaced = await file({ category: "legal_doc", bucket: "secure" }),
      next = await file({ category: "legal_doc", bucket: "secure" });
    const draft = await make.agreementVersion({ status: "draft", sourceFileId: replaced.id });
    expect(await current("agreement_version", replaced.id)).toEqual([
      { fileId: replaced.id, refId: draft.id, role: "source" },
    ]);
    await prisma.agreementVersion.update({
      where: { id: draft.id },
      data: { sourceFileId: next.id },
    });
    expect(await current("agreement_version", replaced.id)).toEqual([]);
    expect(await current("agreement_version", next.id)).toEqual([
      { fileId: next.id, refId: draft.id, role: "source" },
    ]);
    expect(await erase(replaced)).toMatchObject({ status: "deleted" });
  });

  it("账号主体/无主体注销证明和被取代样片意见均按真实关闭三年边界，GET式查询零写", async () => {
    const o = await owner(true),
      proof = await file({ category: "account_proof", bucket: "secure" });
    const deletedUser = await make.merchantUser({
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: END,
      createdAt: OLD,
    });
    const requests: string[] = [];
    for (const userId of [undefined, deletedUser.id]) {
      const request = await approval({
        kind: "account_change",
        subjectId: userId ?? o.entity.id,
        entityId: userId ? undefined : o.entity.id,
        userId,
      });
      const row = await prisma.accountChangeRequest.create({
        data: {
          id: uuidv7(),
          approvalRequestId: request.id,
          kind: userId ? "phone_rebind" : "owner_transfer",
          merchantUserId: userId,
          entityId: userId ? undefined : o.entity.id,
          newPhoneMask: "138****1234",
          proofFileIds: [proof.id],
          reasonCode: "TEST",
          reasonText: "虚构历史核实记录",
          appliedAt: OLD,
          resultSnapshot: {},
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
      requests.push(row.id);
    }
    expect((await current("account_change_request", proof.id)).map((r) => r.refId).sort()).toEqual(
      [...requests].sort(),
    );
    await blocked(
      proof,
      requests.map((refId) => ({ refType: "account_change_request", refId })),
    );

    const ticket = await make.deliveryTicket({
      step: "terminated",
      terminatedAt: END,
      createdAt: OLD,
    });
    const sampleFile = await file({ category: "sample_video", bucket: "asset" }),
      feedback = await file({ category: "ticket_attachment", bucket: "asset" });
    const sample = await prisma.sample.create({
      data: {
        id: uuidv7(),
        entityId: ticket.entityId,
        storeId: ticket.storeId,
        deliveryTicketId: ticket.id,
        versionNo: 1,
        fileId: sampleFile.id,
        status: "superseded",
        uploadedByStaffId: actor.staff.staff.id,
        uploadedAt: OLD,
        adSlots: [],
        adVersionsUsed: [],
        feedbackKind: "compose",
        feedbackNote: "虚构历史修改意见",
        feedbackFileIds: [feedback.id],
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    expect(await current("sample", sampleFile.id)).toEqual([]);
    const before = {
      sample: await prisma.sample.findUniqueOrThrow({ where: { id: sample.id } }),
      account: await prisma.accountChangeRequest.findMany({
        where: { id: { in: requests } },
        orderBy: { id: "asc" },
      }),
      audits: await prisma.auditLog.count(),
      refs: await prisma.fileRef.count(),
    };
    expect(await current("sample", feedback.id)).toEqual([
      { fileId: feedback.id, refId: sample.id, role: "feedback" },
    ]);
    expect(await current("sample", feedback.id)).toEqual([
      { fileId: feedback.id, refId: sample.id, role: "feedback" },
    ]);
    expect(await prisma.sample.findUniqueOrThrow({ where: { id: sample.id } })).toEqual(
      before.sample,
    );
    expect(
      await prisma.accountChangeRequest.findMany({
        where: { id: { in: requests } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before.account);
    expect(await prisma.auditLog.count()).toBe(before.audits);
    expect(await prisma.fileRef.count()).toBe(before.refs);
    await blocked(feedback, [{ refType: "sample", refId: sample.id }]);
    clock.advance(1);
    expect(await current("account_change_request", proof.id)).toEqual([]);
    expect(await current("sample", feedback.id)).toEqual([]);
    expect(await erase(proof)).toMatchObject({ status: "deleted" });
    expect(await erase(feedback)).toMatchObject({ status: "deleted" });
  });
});
