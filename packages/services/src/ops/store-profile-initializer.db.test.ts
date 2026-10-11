import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import type { SessionPrincipal } from "../identity/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  uuidv7,
} from "../kernel/index.js";
import type { IdentityContext, ModuleRegistration } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import {
  assembleForTest,
  assertSnapshotsEqual,
  createClock,
  createFactories,
  createFakeProviders,
  createIdentityForTest,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { createProfile, createStoreProfileInitializer } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import type {
  ProfileViewer,
  StoreProfileCopyOption,
  StoreProfileInitInput,
  StoreProfileInitPlan,
} from "../profile/index.js";

function harness(prisma: PrismaClient, extra: ModuleRegistration[] = []) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api", extra });
  const make = createFactories({ db: prisma, clock }),
    fake = createFakeProviders({ clock });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ assembly, clock, events }),
    tenant = createTenant({ tx, clock, flow, assembly });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    tenant,
    approval,
    events,
    media: { link: media.link, release: media.release, signRead: media.signRead },
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    currentOpenid: async () => "lyxtest_profile_openid",
  });
  return {
    prisma,
    tx,
    clock,
    assembly,
    make,
    fake,
    events,
    flow,
    tenant,
    approval,
    media,
    profile,
  };
}
type Harness = ReturnType<typeof harness>;

async function installDicts(h: Harness) {
  for (const item of [
    {
      dictTypeKey: "industry",
      code: "C900",
      name: "测试开放行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "C901",
      name: "测试开放品类",
      parentCode: "C900",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "region",
      code: "110000",
      name: "测试省",
      parentCode: null,
      ext: { level: 1, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110100",
      name: "测试市",
      parentCode: "110000",
      ext: { level: 2, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110101",
      name: "测试区",
      parentCode: "110100",
      ext: { level: 3, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "store_selling_point",
      code: "SP99",
      name: "测试卖点",
      parentCode: null,
      ext: { categoryCodes: [] },
    },
  ])
    await h.prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: item.dictTypeKey, code: item.code } },
      create: {
        ...item,
        id: uuidv7(),
        isEnabled: true,
        position: 999,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
      update: {},
    });
}
async function ownedFile(h: Harness, viewer: ProfileViewer, category = "profile_image") {
  return h.make.fileObject({
    category,
    bucket: category.startsWith("kyc") ? "secure" : "asset",
    scopeType: category === "kyc_license" ? "entity" : "store",
    entityId: viewer.membership.entityId,
    storeId: category === "kyc_license" ? null : viewer.membership.storeId,
    uploadActorType: "merchant",
    uploadActorId: viewer.principal.merchantUserId,
    uploadClient: "weapp",
  });
}

const db = useSeededDatabase("services", { label: "profcopy", max: 1 });
const APPID = "wxlyxtest00000001",
  SLOW = 60_000;
const TABLES = [
  "store_profile",
  "store_service_item",
  "store_profile_media",
  "file_ref",
  "file_object",
  "store",
  "entity",
  "entity_member",
  "audit_log",
  "status_transition",
  "outbox_event",
  "user_session",
];
let h: Harness, identity: ReturnType<typeof createIdentityForTest>;
let versions: { id: string; agreementKey: string }[];
let sequence = 77_000_000;
const initial = { addressDetail: "新店公开测试路一号", industryCode: "C900", categoryCode: "C901" };
beforeAll(async () => {
  h = harness(await db.prisma());
  await installDicts(h);
  versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await h.prisma.agreementVersion.findFirst({
          where: { agreementKey, status: "active" },
        })) ?? h.make.agreementVersion({ agreementKey }),
    ),
  );
  identity = createIdentityForTest({
    ...h,
    docs: createDocs({ tx: h.tx, clock: h.clock }),
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    appid: APPID,
  });
}, 120_000);
const factory = (media = h.media) =>
  createStoreProfileInitializer({ clock: h.clock, tenant: h.tenant, media, expectedAppid: APPID });
async function world(populate = true) {
  const code = uuidv7(),
    meta = {
      requestId: code,
      ip: "203.0.113.50",
      userAgent: "公开档案复制夹具",
      clientVersion: null,
    };
  h.fake.wechat.sessions.set(code, { openid: `profile_copy_${code}` });
  h.fake.wechat.phones.set(code, `139${++sequence}`);
  const login = await identity.phoneLogin(meta, {
    loginCode: code,
    phoneCode: code,
    consents: versions.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
  });
  const auth = await identity.authenticate(login.token, { ip: meta.ip });
  if (!auth.ok) throw new Error("真实登录未产生当前会话");
  const principal = auth.principal;
  const actor = {
    type: "merchant" as const,
    id: principal.merchantUserId,
    client: "weapp" as const,
  };
  const created = await h.tenant.createEntity(createIdentityContext({ actor }));
  const ctx = createIdentityContext({
    actor,
    entityId: created.entityId,
    storeId: created.storeId,
  });
  // 分店是合法历史行；当前前置不声称尚未实现的 createStore HTTP 已交付。
  const target = await h.make.store({ entityId: created.entityId, name: "目标新店" });
  const viewer = {
    ctx,
    principal,
    membership: {
      memberId: created.memberId,
      entityId: created.entityId,
      storeId: created.storeId,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  let fileId: string | null = null;
  if (populate) {
    const file = await ownedFile(h, viewer);
    fileId = file.id;
    await h.profile.updateBasic(viewer, {
      draft: true,
      lockVersion: 0,
      brandName: "公开源品牌",
      brandIntro: "源简介",
      businessHours: [{ start: "09:00", end: "18:00" }],
      logoFileId: file.id,
      storeTel: "010-12345678",
      avgSpendFen: 9900,
    });
    await h.profile.updateMedia(viewer, {
      draft: true,
      lockVersion: 1,
      groups: { door: [{ fileId: file.id }] },
    });
    await h.profile.updateService(viewer, {
      draft: true,
      lockVersion: 2,
      promoText: "源优惠",
      groupBuyText: "源团购",
      sellingPointCodes: ["SP99"],
      sellingNote: "源卖点",
      serviceItems: [
        {
          name: "源服务",
          priceFen: 900,
          originalPriceFen: 1000,
          imageFileId: file.id,
          intro: "真实来源简介",
        },
      ],
    });
  }
  const input: StoreProfileInitInput = {
    contextStoreId: created.storeId,
    targetStoreId: target.id,
    copyFromStoreId: created.storeId,
    copyOptions: ["basic", "service", "media"],
    initial: { ...initial },
  };
  return { ...created, target, principal, ctx, viewer, fileId, input };
}
type World = Awaited<ReturnType<typeof world>>;
const copy = (w: World, input = w.input, one = factory()) =>
  h.tx.run(async (tx) => one.apply(tx, await one.prepare(tx, w.ctx, w.principal, input)));
const targetRows = async (w: World) => {
  const service = await h.prisma.storeServiceItem.findMany({ where: { storeId: w.target.id } });
  const media = await h.prisma.storeProfileMedia.findMany({ where: { storeId: w.target.id } });
  return {
    profile: await h.prisma.storeProfile.findUnique({ where: { storeId: w.target.id } }),
    service,
    media,
    refs: await h.prisma.fileRef.findMany({
      where: {
        refId: { in: [w.target.id, ...service.map((r) => r.id), ...media.map((r) => r.id)] },
      },
    }),
  };
};
const empty = async (w: World) =>
  expect(await targetRows(w)).toEqual({ profile: null, service: [], media: [], refs: [] });

describe("profile 门店初始化：真实 callerTx、来源与不可变元数据", { timeout: SLOW }, () => {
  it.each([
    { options: [] },
    { options: ["basic"] },
    { options: ["service"] },
    { options: ["media"] },
    { options: ["basic", "service", "media"] },
  ] as { options: StoreProfileCopyOption[] }[])(
    "精确选择 $options，仅复制对应列及真实引用",
    async ({ options }) => {
      const w = await world();
      const source = await h.prisma.storeProfile.findUniqueOrThrow({
        where: { storeId: w.storeId },
      });
      const audit = await h.prisma.auditLog.count(),
        events = await h.prisma.outboxEvent.count();
      const check = vi.spyOn(h.fake.wechat, "checkText"),
        sign = vi.spyOn(h.fake.storage, "presignGet");
      try {
        await copy(w, { ...w.input, copyOptions: options });
        const rows = await targetRows(w),
          p = rows.profile!;
        expect(p).toMatchObject({
          ...initial,
          copiedFromStoreId: w.storeId,
          copyOptions: options,
          storeTel: null,
          avgSpendFen: null,
          provinceCode: null,
          contactName: null,
          contactPhoneEnc: null,
          effectiveQualificationSubmissionId: null,
          firstSubmittedAt: null,
          firstVerifiedAt: null,
          lastDecidedAt: null,
          finalRejectedAt: null,
          lockVersion: 0,
        });
        expect(p.brandName).toBe(options.includes("basic") ? source.brandName : null);
        expect(p.brandIntro).toBe(options.includes("basic") ? source.brandIntro : null);
        expect(p.businessHours).toEqual(options.includes("basic") ? source.businessHours : []);
        expect(p.logoFileId).toBe(options.includes("basic") ? w.fileId : null);
        expect(p.promoText).toBe(options.includes("service") ? "源优惠" : null);
        expect(p.groupBuyText).toBe(options.includes("service") ? "源团购" : null);
        expect(p.sellingPointCodes).toEqual(options.includes("service") ? ["SP99"] : []);
        expect(p.sellingNote).toBe(options.includes("service") ? "源卖点" : null);
        expect(rows.service).toHaveLength(options.includes("service") ? 1 : 0);
        expect(rows.media).toHaveLength(options.includes("media") ? 1 : 0);
        expect(rows.refs).toHaveLength(options.length);
        expect(rows.refs.every((r) => r.fileId === w.fileId && r.state === "live")).toBe(true);
        if (rows.service[0]) {
          expect(rows.service[0]).toMatchObject({
            name: "源服务",
            priceFen: 900,
            originalPriceFen: 1000,
            intro: "真实来源简介",
            imageFileId: w.fileId,
            position: 1,
            removedAt: null,
          });
          expect(rows.refs).toContainEqual(
            expect.objectContaining({
              refType: "store_service_item",
              refId: rows.service[0].id,
              role: "image",
            }),
          );
        }
        if (rows.media[0]) {
          expect(rows.media[0]).toMatchObject({
            mediaGroup: "door",
            mediaKind: "image",
            position: 1,
            copiedFromStoreId: w.storeId,
            createActorType: "merchant",
            createActorId: w.principal.merchantUserId,
            createClient: "weapp",
          });
          expect(rows.refs).toContainEqual(
            expect.objectContaining({
              refType: "store_profile_media",
              refId: rows.media[0].id,
              role: "main",
            }),
          );
        }
        expect(await h.prisma.storeProfile.findUnique({ where: { storeId: w.storeId } })).toEqual(
          source,
        );
        expect(await h.prisma.store.findUnique({ where: { id: w.target.id } })).toEqual(w.target);
        expect(await h.prisma.auditLog.count()).toBe(audit);
        expect(await h.prisma.outboxEvent.count()).toBe(events);
        expect(p.requiredTotal).toBeGreaterThan(0);
        expect(p.requiredFilled).toBeGreaterThan(0);
        expect(p.completenessPct).toBeLessThan(100);
        expect(check).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
      } finally {
        check.mockRestore();
        sign.mockRestore();
      }
    },
  );
  it("prepare零写，首次INSERT已有完整metadata；既有DB禁止后补修改", async () => {
    const w = await world(),
      before = await snapshotTables(h.prisma, TABLES),
      one = factory();
    await h.tx.run(async (tx) => {
      const plan = await one.prepare(tx, w.ctx, w.principal, w.input);
      expect(plan.fileIds).toEqual([w.fileId]);
      expect(await tx.storeProfile.findUnique({ where: { storeId: w.target.id } })).toBeNull();
      const insert = vi.spyOn(tx.storeProfile, "create");
      try {
        await one.apply(tx, plan);
        expect(insert).toHaveBeenCalledTimes(1);
        expect(insert.mock.calls[0]![0]!.data).toMatchObject({
          copiedFromStoreId: w.storeId,
          copyOptions: ["basic", "service", "media"],
        });
      } finally {
        insert.mockRestore();
      }
    });
    expect(before.store_profile).not.toEqual(
      (await snapshotTables(h.prisma, TABLES)).store_profile,
    );
    await expect(
      h.prisma.storeProfile.update({ where: { storeId: w.target.id }, data: { copyOptions: [] } }),
    ).rejects.toThrow();
    expect((await targetRows(w)).profile?.copyOptions).toEqual(w.input.copyOptions);
  });
  it.each(["source-empty", "without-source"] as const)(
    "%s 初始化真实空值，来源缺档案不补行",
    async (kind) => {
      const w = await world(false);
      await copy(
        w,
        kind === "without-source"
          ? { ...w.input, copyFromStoreId: null, copyOptions: [] }
          : w.input,
      );
      expect(await h.prisma.storeProfile.findUnique({ where: { storeId: w.storeId } })).toBeNull();
      const rows = await targetRows(w);
      expect(rows.profile).toMatchObject({
        ...initial,
        copiedFromStoreId: kind === "without-source" ? null : w.storeId,
        copyOptions: kind === "without-source" ? [] : w.input.copyOptions,
        brandName: null,
        logoFileId: null,
      });
      expect(rows.service).toEqual([]);
      expect(rows.media).toEqual([]);
      expect(rows.refs).toEqual([]);
    },
  );
  it("正式by_owner来源允许，来源行、资格和旧引用不复活或改变", async () => {
    const w = await world();
    const source = await h.make.store({
      entityId: w.entityId,
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: w.principal.merchantUserId,
      archiveClient: "weapp",
    });
    await h.prisma.storeProfile.create({
      data: {
        storeId: source.id,
        entityId: w.entityId,
        brandName: "归档品牌",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await copy(w, { ...w.input, copyFromStoreId: source.id, copyOptions: ["basic"] });
    expect((await targetRows(w)).profile).toMatchObject({
      brandName: "归档品牌",
      copiedFromStoreId: source.id,
    });
    expect(await h.prisma.store.findUnique({ where: { id: source.id } })).toEqual(source);
  });
  it.each(["draft_deleted", "entity_closed", "entity_abandoned"] as const)(
    "拒绝%s来源，不静默复制",
    async (archiveReason) => {
      const w = await world(false);
      const source = await h.make.store({
        entityId: w.entityId,
        lifecycle: "archived",
        archiveReason,
        archivedAt: h.clock.now(),
        archiveActorType: "merchant",
        archiveActorId: w.principal.merchantUserId,
        archiveClient: "weapp",
      });
      await expect(copy(w, { ...w.input, copyFromStoreId: source.id })).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
      await empty(w);
    },
  );
  it.each([
    "duplicate",
    "brand_assets",
    "no-source",
    "foreign",
    "self",
    "address",
    "category",
    "existing",
  ] as const)("%s输入/当前事实拒绝且零业务写", async (kind) => {
    const w = await world(false),
      input = {
        ...w.input,
        copyOptions: [...w.input.copyOptions],
        initial: { ...w.input.initial },
      };
    if (kind === "duplicate") input.copyOptions = ["basic", "basic"];
    if (kind === "brand_assets") Object.assign(input, { copyOptions: ["brand_assets"] });
    if (kind === "no-source") input.copyFromStoreId = null;
    if (kind === "foreign") input.copyFromStoreId = (await h.make.store()).id;
    if (kind === "self") input.copyFromStoreId = input.targetStoreId;
    if (kind === "address") input.initial.addressDetail = "界".repeat(201);
    if (kind === "category") input.initial.categoryCode = "C900";
    if (kind === "existing")
      await h.prisma.storeProfile.create({
        data: {
          storeId: w.target.id,
          entityId: w.entityId,
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(copy(w, input)).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  });
  it.each(["block", "deleted", "category", "foreign-file"] as const)(
    "真实文件%s沿Media.link整笔FILE_NOT_USABLE",
    async (kind) => {
      const w = await world();
      if (kind === "block")
        await h.prisma.fileObject.update({
          where: { id: w.fileId! },
          data: { moderationState: "block" },
        });
      if (kind === "deleted")
        await h.prisma.fileObject.update({
          where: { id: w.fileId! },
          data: { status: "deleted", deletedAt: h.clock.now() },
        });
      if (kind === "category" || kind === "foreign-file") {
        const foreign = kind === "foreign-file" ? await h.make.store() : null;
        const replacement =
          kind === "category"
            ? await ownedFile(h, w.viewer, "kyc_license")
            : await h.make.fileObject({
                category: "profile_image",
                scopeType: "store",
                entityId: foreign!.entityId,
                storeId: foreign!.id,
              });
        await h.prisma.storeProfile.update({
          where: { storeId: w.storeId },
          data: { logoFileId: replacement.id },
        });
      }
      const before = await snapshotTables(h.prisma, TABLES);
      await expect(copy(w)).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
      await empty(w);
    },
  );
  it("未移除集合、caption和位置真实复制，新ID；移除项与源元数据不复用", async () => {
    const w = await world();
    const service = await h.prisma.storeServiceItem.findFirstOrThrow({
      where: { storeId: w.storeId },
    });
    const media = await h.prisma.storeProfileMedia.findFirstOrThrow({
      where: { storeId: w.storeId },
    });
    await h.prisma.storeProfileMedia.update({
      where: { id: media.id },
      data: { caption: "既有公开图注" },
    });
    await h.prisma.storeServiceItem.create({
      data: { ...service, id: uuidv7(), position: 2, removedAt: h.clock.now() },
    });
    await h.prisma.storeProfileMedia.create({
      data: { ...media, id: uuidv7(), position: 2, removedAt: h.clock.now() },
    });
    await copy(w);
    const rows = await targetRows(w);
    expect(rows.service).toHaveLength(1);
    expect(rows.service[0]!.id).not.toBe(service.id);
    expect(rows.media).toHaveLength(1);
    expect(rows.media[0]!.id).not.toBe(media.id);
    expect(rows.media[0]).toMatchObject({ caption: "既有公开图注", position: 1 });
  });
  it.each(["second-link", "completeness", "outer"] as const)(
    "%s失败，所有已写行/引用与文件事实全回滚",
    async (kind) => {
      const w = await world(),
        before = await snapshotTables(h.prisma, TABLES),
        failure = new Error("公开虚构回滚标记");
      const one = factory();
      let count = 0;
      const actual = h.media.link;
      const linkSpy = vi.spyOn(h.media, "link").mockImplementation(async (...args) => {
        await actual(...args);
        if (kind === "second-link" && ++count === 2) throw failure;
      });
      try {
        await expect(
          h.tx.run(async (tx) => {
            const plan = await one.prepare(tx, w.ctx, w.principal, w.input);
            const update = vi.spyOn(tx.storeProfile, "update");
            if (kind === "completeness") update.mockRejectedValueOnce(failure);
            try {
              await one.apply(tx, plan);
              if (kind === "outer") throw failure;
            } finally {
              update.mockRestore();
            }
          }),
        ).rejects.toBe(failure);
        assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
      } finally {
        linkSpy.mockRestore();
      }
    },
  );
  it.each(["clone", "other-instance", "cross-tx", "consumed"] as const)(
    "%s计划不授予写权限",
    async (kind) => {
      const w = await world(false),
        one = factory();
      let plan!: StoreProfileInitPlan;
      if (kind === "cross-tx") {
        await h.tx.run(async (tx) => {
          plan = await one.prepare(tx, w.ctx, w.principal, w.input);
        });
        await expect(h.tx.run((tx) => one.apply(tx, plan))).rejects.toBeInstanceOf(TypeError);
        await empty(w);
        return;
      }
      await h.tx.run(async (tx) => {
        plan = await one.prepare(tx, w.ctx, w.principal, w.input);
        if (kind === "clone")
          await expect(one.apply(tx, { ...plan })).rejects.toBeInstanceOf(TypeError);
        if (kind === "other-instance")
          await expect(factory().apply(tx, plan)).rejects.toBeInstanceOf(TypeError);
        if (kind === "consumed") {
          await one.apply(tx, plan);
          await expect(one.apply(tx, plan)).rejects.toBeInstanceOf(TypeError);
        }
      });
      if (kind !== "consumed") await empty(w);
    },
  );
  it("prepare深拷贝输入，公开文件数组冻结，调用期间更改不能换来源/授权", async () => {
    const w = await world(),
      one = factory(),
      raw = { ...w.input, copyOptions: [...w.input.copyOptions], initial: { ...w.input.initial } };
    await h.tx.run(async (tx) => {
      const plan = await one.prepare(tx, w.ctx, w.principal, raw);
      raw.initial.addressDetail = "篡改地址";
      raw.copyOptions = [];
      raw.copyFromStoreId = uuidv7();
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.fileIds)).toBe(true);
      expect(Reflect.set(plan.fileIds, "0", uuidv7())).toBe(false);
      expect(plan.fileIds).toEqual([w.fileId]);
      await one.apply(tx, plan);
    });
    expect((await targetRows(w)).profile).toMatchObject({
      ...initial,
      copiedFromStoreId: w.storeId,
      copyOptions: ["basic", "service", "media"],
    });
  });
  it.each([
    "actor",
    "context",
    "session",
    "appid",
    "removed",
    "clerk",
    "revoked",
    "disabled",
  ] as const)("%s伪造或失效不能以旧owner对象准入", async (kind) => {
    const w = await world(false);
    let ctx: IdentityContext = w.ctx,
      principal: SessionPrincipal = w.principal,
      one = factory();
    if (kind === "actor")
      ctx = createIdentityContext({
        actor: { type: "merchant", id: uuidv7(), client: "weapp" },
        entityId: w.entityId,
        storeId: w.storeId,
      });
    if (kind === "context")
      ctx = createIdentityContext({
        actor: w.ctx.actor,
        entityId: w.entityId,
        storeId: w.target.id,
      });
    if (kind === "session") principal = { ...principal, sessionId: uuidv7() };
    if (kind === "appid")
      one = createStoreProfileInitializer({
        clock: h.clock,
        tenant: h.tenant,
        media: h.media,
        expectedAppid: "wxpublicwrong",
      });
    if (kind === "revoked")
      await h.prisma.userSession.update({
        where: { id: w.principal.sessionId },
        data: { revokedAt: h.clock.now(), revokeReason: "logout" },
      });
    if (kind === "disabled")
      await h.prisma.merchantUser.update({
        where: { id: w.principal.merchantUserId },
        data: { status: "disabled" },
      });
    if (kind === "removed")
      await h.prisma.entityMember.update({
        where: { id: w.memberId },
        data: {
          status: "removed",
          displayName: null,
          removedAt: h.clock.now(),
          removeActorType: "merchant",
          removeActorId: w.principal.merchantUserId,
          removeClient: "weapp",
          removeReason: "draft_abandoned",
        },
      });
    if (kind === "clerk")
      await h.prisma.entityMember.update({
        where: { id: w.memberId },
        data: { role: "clerk", invitedByMemberId: w.memberId },
      });
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(
      h.tx.run(async (tx) => one.apply(tx, await one.prepare(tx, ctx, principal, w.input))),
    ).rejects.toThrow();
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  });
  it.each(["disabled", "closed"] as const)("最终字典%s不能沿旧已校验输入写入", async (kind) => {
    const w = await world(false);
    const key = { dictTypeKey: "industry", code: "C901" };
    const old = await h.prisma.dictItem.findUniqueOrThrow({ where: { dictTypeKey_code: key } });
    const ext = old.ext;
    if (ext === null) throw new Error("真实开放行业夹具缺少扩展事实");
    await h.prisma.dictItem.update({
      where: { id: old.id },
      data:
        kind === "disabled"
          ? { isEnabled: false }
          : { ext: { open: false, special: false, requiredCerts: [] } },
    });
    try {
      await expect(copy(w)).rejects.toMatchObject({
        error: kind === "disabled" ? "DICT_ITEM_DISABLED" : "INDUSTRY_NOT_OPEN",
      });
      await empty(w);
    } finally {
      await h.prisma.dictItem.update({
        where: { id: old.id },
        data: { isEnabled: old.isEnabled, ext },
      });
    }
  });
});
