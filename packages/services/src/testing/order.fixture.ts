// W1-15a：应用验收的公开夹具。接收真实 API 已建主体/门店/老板，不在应用测试中跨入领域私有夹具。
import type { PrismaClient } from "@liyoxi/db";
import type { OrderCreateBody } from "@liyoxi/contract";
import { runInvariants } from "../ops/index.js";
import type { Assembly } from "../kernel/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { OrderActor, OrderService } from "../order/index.js";
import { createLedgerHarness, openTerm, priceDrama } from "./billing.js";
import type { LedgerHarness } from "./billing.js";
import type { AdjustableClock } from "./clock.js";
import { testSealer } from "./data/seal.js";
import { fakeUscc } from "./data/factories/context.js";

export async function prepareOrderProfile(
  prisma: PrismaClient,
  h: LedgerHarness,
  actor: OrderActor,
) {
  const { entityId, storeId } = actor.membership,
    now = h.clock.now();
  const dicts = [
    {
      dictTypeKey: "industry",
      code: "W115I",
      name: "测试行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "W115C",
      name: "测试品类",
      parentCode: "W115I",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    ...["W115P", "W115M", "W115D"].map((code, index) => ({
      dictTypeKey: "region",
      code,
      name: code,
      parentCode: index === 0 ? null : ["W115P", "W115M"][index - 1]!,
      ext: { level: index + 1, functionalZone: false, opened: true },
    })),
    { dictTypeKey: "custom_focus", code: "W115F", name: "主推服务", parentCode: null, ext: {} },
  ];
  for (const d of dicts)
    await prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: d.dictTypeKey, code: d.code } },
      create: {
        id: uuidv7(),
        ...d,
        isEnabled: true,
        position: 999,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
  await prisma.storeProfile.create({
    data: {
      storeId,
      entityId,
      brandName: "测试品牌",
      industryCode: "W115I",
      categoryCode: "W115C",
      provinceCode: "W115P",
      cityCode: "W115M",
      districtCode: "W115D",
      addressDetail: "测试路一号",
      businessHours: [{ start: "09:00", end: "18:00" }],
      storeTel: "01012345678",
      avgSpendFen: 1000,
      sellingPointCodes: ["service"],
      createdAt: now,
      updatedAt: now,
    },
  });
  for (let i = 0; i < 4; i++) {
    const f = await h.make.fileObject({
      category: "profile_image",
      bucket: "asset",
      entityId,
      storeId,
      scopeType: "store",
    });
    await prisma.storeProfileMedia.create({
      data: {
        id: uuidv7(),
        entityId,
        storeId,
        fileId: f.id,
        mediaGroup: i === 0 ? "door" : "interior",
        position: i === 0 ? 1 : i,
        mediaKind: "image",
        createActorType: "merchant",
        createActorId: actor.ctx.actor.id!,
        createClient: "weapp",
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  await prisma.storeServiceItem.create({
    data: {
      id: uuidv7(),
      entityId,
      storeId,
      name: "主推服务",
      priceFen: 1000,
      position: 1,
      createdAt: now,
      updatedAt: now,
    },
  });
}
export async function prepareOrderDrama(h: LedgerHarness, points = 101) {
  const poster = await h.make.fileObject({
      category: "poster",
      scopeType: "platform",
      ext: "jpg",
      mime: "image/jpeg",
      declaredMime: "image/jpeg",
    }),
    d = await h.make.drama({
      dramaClass: "class_3",
      heatTier: "A",
      genreCodes: ["comedy"],
      posterFileId: poster.id,
      allowedPlacements: ["opening", "ending"],
    }),
    now = h.clock.now();
  await h.prisma.dramaCopyright.create({
    data: {
      dramaId: d.id,
      platforms: ["douyin", "wechat_channels"],
      licenseStartDate: new Date("2020-01-01"),
      licenseEndDate: new Date("2035-12-31"),
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.dramaPermit.create({
    data: {
      id: uuidv7(),
      dramaId: d.id,
      platform: "all",
      permitKind: "program_no",
      permitNo: `test_${d.id}`,
      status: "active",
      createdByStaffId: d.createdByStaffId,
      createdAt: now,
      updatedAt: now,
    },
  });
  await priceDrama(h, { dramaId: d.id, points, staffId: d.createdByStaffId });
  return d;
}
export async function prepareOrderAgreement(h: LedgerHarness) {
  return (
    (await h.prisma.agreementVersion.findFirst({
      where: { agreementKey: "custom_license", status: "active" },
    })) ?? h.make.agreementVersion()
  );
}

export async function prepareOrderFixture(
  prisma: PrismaClient,
  runtime: { readonly order: OrderService },
  clock: AdjustableClock,
  scope: { entityId: string; storeId: string; memberId: string; merchantUserId: string },
) {
  const h = createLedgerHarness(prisma, { clock }),
    now = clock.now();
  const actor: OrderActor = {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: scope.merchantUserId, client: "weapp" },
      requestId: `order_fixture_${uuidv7()}`,
    }),
    membership: {
      memberId: scope.memberId,
      entityId: scope.entityId,
      storeId: scope.storeId,
      role: "owner",
      storeMode: "active",
    },
  };
  // 与表工厂相同的真实测试密钥三件套；仅准备测试前置，不进入生产装配。
  const uscc = testSealer.uscc("entity.uscc_enc", fakeUscc(100000 + (await prisma.entity.count())));
  await prisma.entity.update({
    where: { id: scope.entityId },
    data: {
      name: "订剧验收主体",
      entityType: "enterprise",
      verificationStatus: "verified",
      verifiedAt: now,
      usccEnc: uscc.enc,
      usccBidx: uscc.bidx,
      usccMask: uscc.mask,
      updatedAt: now,
    },
  });
  await prisma.store.update({
    where: { id: scope.storeId },
    data: { name: "订剧验收门店", qualificationStatus: "verified", updatedAt: now },
  });
  await prepareOrderProfile(prisma, h, actor);
  await openTerm(h, { entityId: scope.entityId, planCode: "pro" });
  const staff = await h.make.staff({ staffRoleKey: "publisher" }),
    channelAccountId = uuidv7();
  await prisma.channelAccount.create({
    data: {
      id: channelAccountId,
      entityId: scope.entityId,
      storeId: scope.storeId,
      platform: "douyin",
      accountName: "订剧验收账号",
      accountUid: channelAccountId,
      accountUidNorm: channelAccountId,
      status: "available",
      accountType: "personal",
      submittedAt: now,
      verifiedAt: now,
      verifiedByStaffId: staff.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const drama = await prepareOrderDrama(h),
    agreement = await prepareOrderAgreement(h);
  const quote = await runtime.order.quote(actor, {
    dramaIds: [drama.id],
    channelAccountIds: [channelAccountId],
    isTopModel: false,
  });
  const input: OrderCreateBody = {
    dramaIds: [drama.id],
    channelAccountIds: [channelAccountId],
    focusCodes: ["W115F"],
    isTopModel: false,
    agreementVersionId: quote.agreement.agreementVersionId,
    expect: quote.expect,
  };
  return { actor, channelAccountId, dramaId: drama.id, agreementVersionId: agreement.id, input };
}

/** 真实已登记 full 运行经测试入口调用，领域测试不向上 import ops。 */
export const checkOrderFixtureInvariants = (
  h: Pick<LedgerHarness, "tx" | "clock"> & { readonly assembly: Assembly },
  entityId: string,
) =>
  runInvariants(h, {
    mode: "full",
    trigger: "manual",
    modules: ["order", "billing"],
    entityIds: [entityId],
  });
