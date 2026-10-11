import type { PrismaClient } from "@liyoxi/db";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import { createApproval } from "../../approval/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { DeliveredEvent } from "../../kernel/index.js";
import { createMedia } from "../../media/index.js";
import type { RefRetentionInput } from "../../media/index.js";
import { createProfile, createProfileTenantLifecycle } from "../../profile/index.js";
import type { ProfileViewer } from "../../profile/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  TEST_KEYRING,
} from "../../testing/index.js";
import { createTimers, timerKey } from "../../timers/index.js";
import { createProfileLifecycleAssembly } from "../profile-lifecycle-runtime.js";

export const DAY = 86_400_000;
export const START = new Date("2026-01-05T04:00:00.000Z");
let initialSequence = 0;
export type RoundKind = "initial" | "new_store" | "change";
export type LifecycleType =
  | "entity.closed"
  | "entity.abandoned"
  | "store.archived"
  | "store.draft_deleted"
  | "store.restored";
export type ArchiveReason = "by_owner" | "draft_deleted" | "entity_closed" | "entity_abandoned";

export function lifecycleWorld(prisma: PrismaClient) {
  const clock = createClock(START);
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const scope = createProfileLifecycleAssembly(assembleForTest({ entry: "worker" }));
  const assembly = scope.assembly;
  const events = createEvents({ tx, clock, assembly });
  const flow = createFlow({ clock, events, assembly });
  const timers = createTimers({ assembly });
  const approval = createApproval({
    clock,
    events,
    flow,
    assembly,
    timers,
    sla: createSla({ clock, assembly }),
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const tenant = createTenant({ tx, clock, flow, assembly });
  const fake = createFakeProviders({ clock });
  const media = createMedia({ tx, clock, events, assembly, storage: fake.storage });
  const deps = { clock, tenant, approval, events, media };
  const lifecycle = createProfileTenantLifecycle(deps);
  scope.attach(lifecycle);
  const make = createFactories({ db: prisma, clock });
  const system = createIdentityContext({
    actor: { type: "system", job: "lyxtest.profile_lifecycle" },
    requestId: "lyxtest_lifecycle",
  });
  const profileFor = (client: PrismaClient = prisma) =>
    createProfile({
      tx: client === prisma ? tx : createTxRunner({ prisma: client, appEnv: "test" }),
      clock,
      assembly,
      tenant,
      approval,
      events,
      media: { link: media.link, release: media.release, signRead: media.signRead },
      keyring: () => TEST_KEYRING,
      wechat: fake.wechat,
      currentOpenid: async () => "lyxtest_lifecycle_openid",
    });

  async function owner(kind: RoundKind = "initial") {
    const user = await make.merchantUser();
    const entity = await make.entity({
      createdByUserId: user.id,
      verificationStatus: kind === "initial" ? "unsubmitted" : "verified",
    });
    const store = await make.store({
      entityId: entity.id,
      isPrimary: kind !== "new_store",
      qualificationStatus: kind === "change" ? "verified" : "unsubmitted",
    });
    const ctx = createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp" },
      entityId: entity.id,
      storeId: store.id,
    });
    await prisma.storeProfile.create({
      data: {
        storeId: store.id,
        entityId: entity.id,
        brandName: "生命周期测试品牌",
        industryCode: "LCI",
        categoryCode: "LCC",
        provinceCode: "LCP",
        cityCode: "LCM",
        districtCode: "LCD",
        addressDetail: "测试路一号",
        businessHours: [{ start: "09:00", end: "18:00" }],
        storeTel: "010-12345678",
        avgSpendFen: 1000,
        sellingPointCodes: ["SP01"],
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    return { user, entity, store, ctx };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;

  async function file(o: Owner, category: UploadCategory = "profile_image") {
    return make.fileObject({
      category,
      bucket: category.startsWith("kyc_") ? "secure" : "asset",
      scopeType: category === "kyc_license" ? "entity" : "store",
      entityId: o.entity.id,
      storeId: category === "kyc_license" ? null : o.store.id,
      uploadActorType: "merchant",
      uploadActorId: o.user.id,
      uploadClient: "weapp",
    });
  }
  const ref = (o: Owner, fileId: string, refType: string, refId: string, role: string) =>
    ({
      fileId,
      refType,
      refId,
      role,
      entityId: o.entity.id,
      storeId: o.store.id,
    }) satisfies RefRetentionInput;

  async function draft(o: Owner, kind: RoundKind = "initial") {
    // 合法历史轮次，不冒称 change/new_store 的商家提交 producer 已开放。
    const round = await prisma.qualificationSubmission.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        kind,
        claimedEntityType: "enterprise",
        changedFields: kind === "change" ? ["docs"] : [],
        createdByUserId: o.user.id,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const image = await file(o, "kyc_license");
    const doc = await prisma.qualificationDoc.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        qualificationSubmissionId: round.id,
        docType: "business_license",
        scope: "entity",
        origin: "uploaded",
        fileId: image.id,
        uploadedByUserId: o.user.id,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const input = ref(o, image.id, "qualification_doc", doc.id, "main");
    await tx.run((t) => media.link(t, input));
    return { ...o, round, doc, image, input };
  }
  type Draft = Awaited<ReturnType<typeof draft>>;

  async function submitted(f: Draft) {
    const result = await tx.run(async (t) => {
      await lockRows(t, "qualification_submission", [f.round.id]);
      const request = await approval.submit(t, f.ctx, {
        kind: "qualification",
        subjectType: "store",
        subjectId: f.store.id,
        entityId: f.entity.id,
        storeId: f.store.id,
        input: { submissionId: f.round.id, roundNo: 1 },
      });
      if (f.round.kind === "initial") {
        await tenant.setStoreQualification(t, f.ctx, {
          storeId: f.store.id,
          round: "initial",
          action: "submit",
        });
      } else if (f.round.kind === "new_store") {
        // 复用既有正式状态机造提交前史；这不是新增门店提交用例。
        await flow.transition(t, f.ctx, {
          machine: "store",
          stateField: "qualification_status",
          id: f.store.id,
          event: "qualification.submit",
          entityId: f.entity.id,
          storeId: f.store.id,
          emit: { none: true, primary: "store.qualification.submitted" },
        });
      }
      await t.qualificationSubmission.update({
        where: { id: f.round.id },
        data: {
          approvalRequestId: request.approvalId,
          roundNo: 1,
          submittedAt: clock.now(),
          submittedByUserId: f.user.id,
          declarationConfirmedAt: clock.now(),
          declarationVersion: "1",
          proposedStoreName: f.store.name,
          proposedIndustryCode: "LCI",
          proposedCategoryCode: "LCC",
          proposedAddressSnapshot: { detail: "测试路一号" },
          updatedAt: clock.now(),
        },
      });
      return request;
    });
    const request = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: result.approvalId },
    });
    return { ...f, request };
  }

  async function assets(o: Owner, shareImage = false) {
    const logo = await file(o);
    const images = [logo];
    if (!shareImage) images.push(await file(o));
    for (let i = 0; i < 3; i++) images.push(await file(o));
    const rows = [];
    for (let i = 0; i < 4; i++) {
      rows.push(
        await prisma.storeProfileMedia.create({
          data: {
            id: uuidv7(),
            entityId: o.entity.id,
            storeId: o.store.id,
            mediaGroup: i === 0 ? "door" : "interior",
            position: i + 1,
            mediaKind: "image",
            fileId: images[shareImage ? i : i + 1]!.id,
            createActorType: "merchant",
            createActorId: o.user.id,
            createClient: "weapp",
            createdAt: clock.now(),
            updatedAt: clock.now(),
          },
        }),
      );
    }
    const service = await prisma.storeServiceItem.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        position: 1,
        name: "真实测试服务",
        priceFen: 1000,
        imageFileId: logo.id,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await prisma.storeProfile.update({
      where: { storeId: o.store.id },
      data: { logoFileId: logo.id },
    });
    const inputs = [
      ref(o, logo.id, "store_profile", o.store.id, "logo"),
      ...rows.map((row) => ref(o, row.fileId, "store_profile_media", row.id, "main")),
      ref(o, logo.id, "store_service_item", service.id, "image"),
    ];
    await tx.run(async (t) => {
      await lockRows(t, "file_object", [...new Set(inputs.map((v) => v.fileId))].sort());
      for (const input of inputs) await media.link(t, input);
    });
    return { logo, images, rows, service, inputs };
  }

  async function archive(o: Owner, reason: ArchiveReason = "by_owner", at = clock.now()) {
    await prisma.store.update({
      where: { id: o.store.id },
      data: {
        lifecycle: "archived",
        archivedAt: at,
        archiveReason: reason,
        archiveActorType: "system",
        archiveActorId: null,
        archiveClient: null,
        updatedAt: at,
      },
    });
  }
  async function terminate(o: Owner, state: "closed" | "abandoned" = "closed", at = clock.now()) {
    // 生命周期 producer 除 staff close 外仍待交付；这里只构造原 CHECK 允许的历史终态。
    await prisma.entity.update({
      where: { id: o.entity.id },
      data: { lifecycle: state, closedAt: at, updatedAt: at },
    });
    await archive(o, state === "closed" ? "entity_closed" : "entity_abandoned", at);
  }
  async function restore(o: Owner) {
    await prisma.store.update({
      where: { id: o.store.id },
      data: {
        lifecycle: "active",
        archivedAt: null,
        archiveReason: null,
        archiveActorType: null,
        archiveActorId: null,
        archiveClient: null,
        updatedAt: clock.now(),
      },
    });
  }
  async function event(o: Owner, type: LifecycleType): Promise<DeliveredEvent> {
    const current = await prisma.store.findUniqueOrThrow({ where: { id: o.store.id } });
    const subject = { v: 1, entityId: o.entity.id };
    const payload =
      type === "entity.closed"
        ? {
            ...subject,
            closedBy: "staff_close",
            fromState: "active",
            toState: "closed",
            transition: "entity.close",
          }
        : type === "entity.abandoned"
          ? { ...subject, fromState: "active", toState: "abandoned", transition: "entity.abandon" }
          : type === "store.draft_deleted"
            ? { ...subject, storeId: o.store.id }
            : type === "store.restored"
              ? {
                  ...subject,
                  storeId: o.store.id,
                  fromState: "archived",
                  toState: "active",
                  transition: "store.restore",
                }
              : {
                  ...subject,
                  storeId: o.store.id,
                  archiveReason: current.archiveReason ?? "by_owner",
                  fromState: "active",
                  toState: "archived",
                  transition:
                    current.archiveReason === "draft_deleted"
                      ? "store.draft_delete"
                      : current.archiveReason?.startsWith("entity_")
                        ? "store.archive_by_entity"
                        : "store.archive",
                };
    return { id: uuidv7(), type, payload };
  }
  const invoke = (e: DeliveredEvent) => tx.run((t) => lifecycle.onTenantLifecycle(t, e));
  async function emit(o: Owner, e: DeliveredEvent, using = events) {
    const result = await tx.run((t) =>
      using.emit(t, system, {
        type: e.type,
        aggregate: {
          type: e.type.startsWith("entity.") ? "entity" : "store",
          id: e.type.startsWith("entity.") ? o.entity.id : o.store.id,
        },
        entityId: o.entity.id,
        storeId: e.type.startsWith("entity.") ? null : o.store.id,
        payload: e.payload as Record<string, unknown>,
      }),
    );
    if (!result.id) throw new Error("测试事件未实际写入");
    return result.id;
  }
  const readRef = (input: RefRetentionInput) => tx.run((t) => media.readRefRetention(t, input));
  async function snapshot(entityId: string) {
    const files = await prisma.fileObject.findMany({ where: { entityId }, orderBy: { id: "asc" } });
    return {
      entity: await prisma.entity.findUniqueOrThrow({ where: { id: entityId } }),
      stores: await prisma.store.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
      profiles: await prisma.storeProfile.findMany({
        where: { entityId },
        orderBy: { storeId: "asc" },
      }),
      rounds: await prisma.qualificationSubmission.findMany({
        where: { entityId },
        orderBy: { id: "asc" },
      }),
      docs: await prisma.qualificationDoc.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
      approvals: await prisma.approvalRequest.findMany({
        where: { entityId },
        orderBy: { id: "asc" },
      }),
      mediaRows: await prisma.storeProfileMedia.findMany({
        where: { entityId },
        orderBy: { id: "asc" },
      }),
      services: await prisma.storeServiceItem.findMany({
        where: { entityId },
        orderBy: { id: "asc" },
      }),
      files,
      refs: await prisma.fileRef.findMany({
        where: { fileId: { in: files.map((f) => f.id) } },
        orderBy: { id: "asc" },
      }),
      timers: await prisma.timer.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
      history: await prisma.statusTransition.findMany({
        where: { entityId },
        orderBy: { seq: "asc" },
      }),
      audit: await prisma.auditLog.findMany({ where: { entityId }, orderBy: { seq: "asc" } }),
      events: await prisma.outboxEvent.findMany({ where: { entityId }, orderBy: { seq: "asc" } }),
    };
  }
  async function unrelatedTimer(approvalId: string, o: Owner) {
    return tx.run(async (t) => {
      await lockRows(t, "approval_request", [approvalId]);
      return timers.arm(t, {
        kind: "sla.breach",
        subject: { type: "approval_request", id: approvalId },
        key: timerKey("sla.breach", { type: "approval_request", id: approvalId }, "execution"),
        fireAt: new Date(clock.now().getTime() + 30 * DAY),
        entityId: o.entity.id,
        storeId: o.store.id,
      });
    });
  }
  async function readyInitial() {
    const o = await owner();
    const member = await make.entityMember({
      entityId: o.entity.id,
      merchantUserId: o.user.id,
      role: "owner",
    });
    const viewer: ProfileViewer = {
      ctx: o.ctx,
      principal: {
        sessionId: o.user.id,
        merchantUserId: o.user.id,
        wechatIdentityId: o.user.id,
        consentStamp: "test",
      },
      membership: {
        memberId: member.id,
        entityId: o.entity.id,
        storeId: o.store.id,
        role: "owner",
        storeMode: "active",
      },
    };
    for (const item of [
      {
        dictTypeKey: "industry",
        code: "LCI",
        parentCode: null,
        ext: { open: true, special: false, requiredCerts: [] },
      },
      {
        dictTypeKey: "industry",
        code: "LCC",
        parentCode: "LCI",
        ext: { open: true, special: false, requiredCerts: [] },
      },
      {
        dictTypeKey: "region",
        code: "LCP",
        parentCode: null,
        ext: { level: 1, functionalZone: false, opened: true },
      },
      {
        dictTypeKey: "region",
        code: "LCM",
        parentCode: "LCP",
        ext: { level: 2, functionalZone: false, opened: true },
      },
      {
        dictTypeKey: "region",
        code: "LCD",
        parentCode: "LCM",
        ext: { level: 3, functionalZone: false, opened: true },
      },
    ])
      await prisma.dictItem.upsert({
        where: { dictTypeKey_code: { dictTypeKey: item.dictTypeKey, code: item.code } },
        create: {
          ...item,
          id: uuidv7(),
          name: "生命周期测试字典",
          isEnabled: true,
          position: 999,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
        update: {},
      });
    await assets(o);
    const profile = profileFor();
    await profile.updateContact(viewer, {
      lockVersion: 0,
      name: "测试联系人",
      phoneSource: "login",
    });
    const f = await draft(o);
    const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
    const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
    const prefix = `91310000MA1M${String(++initialSequence).padStart(5, "0")}`;
    const sum = [...prefix].reduce((n, c, i) => n + chars.indexOf(c) * weights[i]!, 0);
    // 真实公开提交生成证照加密快照与审批，不手拼已批准的历史事实。
    await profile.updateDocument(viewer, f.doc.id, {
      lockVersion: 0,
      fields: {
        name: "生命周期认证主体",
        uscc: prefix + chars[(31 - (sum % 31)) % 31],
        principal: "张测试",
        principalRole: "legal_rep",
        subjectType: "enterprise",
        validFrom: "2020-01-01",
        validTo: "long_term",
        address: "测试营业地址",
      },
    });
    await profile.submit(viewer, {
      qualificationSubmissionId: f.round.id,
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    return {
      owner: { ...o, viewer },
      ready: { submissionId: f.round.id, docId: f.doc.id },
      profile,
    };
  }
  return {
    prisma,
    clock,
    tx,
    scope,
    assembly,
    events,
    flow,
    timers,
    approval,
    tenant,
    fake,
    media,
    deps,
    lifecycle,
    make,
    system,
    owner,
    file,
    ref,
    draft,
    submitted,
    assets,
    archive,
    terminate,
    restore,
    event,
    invoke,
    emit,
    readRef,
    snapshot,
    unrelatedTimer,
    profileFor,
    readyInitial,
  };
}
export type LifecycleWorld = ReturnType<typeof lifecycleWorld>;
export type LifecycleOwner = Awaited<ReturnType<LifecycleWorld["owner"]>>;
