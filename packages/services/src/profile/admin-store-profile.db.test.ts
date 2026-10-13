import { expect, it, vi } from "vitest";
import { PROXY_EDITABLE_FIELDS, PROXY_FORBIDDEN_FIELDS } from "@liyoxi/contract";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { recentWechatOpenid } from "../identity/index.js";
import { normalizeRoleConfig } from "../authz/index.js";
import { sampleStaffContext, TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import { complete, harness, installDicts, submit } from "./__fixtures__/harness.js";
import { createProfile } from "./service.js";

const db = useSeededDatabase("services", { max: 2 }),
  appid = "wxlyxtestproxy001";
async function world() {
  const h = harness(await db.prisma()),
    owner = await h.owner(),
    actor = await h.make.staff({ staffRoleKey: "super_admin" }),
    staff = await sampleStaffContext(h.prisma, actor.id),
    identity = createIdentityContext({ actor: { type: "staff", id: actor.id, client: "admin" } });
  const wx = await h.prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: owner.user.id,
      appid,
      openid: `lyxtest_proxy_${uuidv7()}`,
      lastLoginAt: h.clock.now(),
      lastActiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const profile = createProfile({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    tenant: h.tenant,
    approval: h.approval,
    events: h.events,
    media: h.media,
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => wx.openid,
    proxyOpenid: (tx, id, now) => recentWechatOpenid(tx, { merchantUserId: id, appid, now }),
  });
  const update = (body: unknown, options = {}) =>
    profile.admin.updateProfile(staff, identity, owner.store.id, body, options);
  const file = (onBehalf = true) =>
    h.make.fileObject({
      category: "profile_image",
      bucket: "asset",
      scopeType: "store",
      entityId: owner.entity.id,
      storeId: owner.store.id,
      onBehalfStoreId: onBehalf ? owner.store.id : null,
      uploadActorType: "staff",
      uploadActorId: actor.id,
      uploadClient: "admin",
    });
  return { ...h, owner, newOwner: h.owner, actor, staff, identity, wx, profile, update, file };
}
type World = Awaited<ReturnType<typeof world>>;
const body = (lockVersion = 0) => ({ lockVersion, reasonCode: "merchant_wecom_request" as const });
const counts = async (h: World) => [
  await h.prisma.storeProfile.count({ where: { storeId: h.owner.store.id } }),
  await h.prisma.storeProfileMedia.count({ where: { storeId: h.owner.store.id } }),
  await h.prisma.storeServiceItem.count({ where: { storeId: h.owner.store.id } }),
  await h.prisma.fileRef.count({ where: { storeId: h.owner.store.id } }),
  await h.prisma.auditLog.count({ where: { storeId: h.owner.store.id } }),
  await h.prisma.outboxEvent.count({ where: { storeId: h.owner.store.id } }),
];
const error = (work: Promise<unknown>, symbol: string) =>
  expect(work).rejects.toMatchObject({ error: symbol });
async function pending(h: World) {
  await vi.waitFor(() => expect(h.fake.wechat.pendingCalls()).toBe(1), {
    timeout: 2000,
    interval: 5,
  });
}
const release = (h: World) => {
  h.clock.advance(100);
  h.fake.wechat.tick();
};

it("空档案GET零写与当前模块/范围；禁改字段和非法输入明确整体零写", async () => {
  const h = await world(),
    before = await counts(h),
    dto = await h.profile.admin.profile(h.staff, h.owner.store.id);
  expect(dto).toMatchObject({
    storeId: h.owner.store.id,
    lockVersion: 0,
    lastEditor: null,
    logo: null,
    serviceItems: [],
    proxyEditableFields: [...PROXY_EDITABLE_FIELDS],
    actions: ["update"],
  });
  expect(await counts(h)).toEqual(before);
  const manager = await h.make.staff({ staffRoleKey: "delivery_manager" }),
    narrow = await sampleStaffContext(h.prisma, manager.id);
  await error(h.profile.admin.profile(narrow, h.owner.store.id), "NOT_FOUND");
  await error(h.profile.admin.profile(h.staff, uuidv7()), "NOT_FOUND");
  const viewer = await h.make.staff({ staffRoleKey: "finance" }),
    readOnly = await sampleStaffContext(h.prisma, viewer.id);
  await error(
    h.profile.admin.updateProfile(
      readOnly,
      createIdentityContext({ actor: { type: "staff", id: viewer.id, client: "admin" } }),
      h.owner.store.id,
      { ...body(), avgSpendFen: 100 },
    ),
    "PERMISSION_DENIED",
  );
  for (const key of PROXY_FORBIDDEN_FIELDS)
    await error(h.update({ ...body(), [key]: null }), "FIELD_NOT_PROXY_EDITABLE");
  for (const input of [
    { ...body(), unknown: true },
    { ...body(), avgSpendFen: -1 },
    { ...body(), businessHours: [{ start: "24:00", end: "12:00" }] },
    { ...body(), serviceItems: [{ name: "空价", priceFen: 0 }] },
  ])
    await error(h.update(input), "VALIDATION_FAILED");
  await error(h.update(body()), "PROXY_EDIT_NO_CHANGE");
  expect(await counts(h)).toEqual(before);
  const archived = await h.make.store({
    entityId: h.owner.entity.id,
    lifecycle: "archived",
    archivedAt: h.clock.now(),
    archiveReason: "by_owner",
    archiveActorType: "merchant",
    archiveActorId: h.owner.user.id,
    archiveClient: "weapp",
  });
  await error(
    h.profile.admin.updateProfile(h.staff, h.identity, archived.id, {
      ...body(),
      avgSpendFen: 100,
    }),
    "STATE_NOT_ALLOWED",
  );
  expect(await h.prisma.storeProfile.findUnique({ where: { storeId: archived.id } })).toBeNull();
  // 已缓存的all也不能绕过当前角色的模块撤权。
  const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "finance" } }),
    levels = normalizeRoleConfig("finance", role).moduleLevels;
  await h.prisma.staffRole.update({
    where: { key: "finance" },
    data: { moduleLevels: { ...levels, merchant: "n" } },
  });
  try {
    await h.prisma.staff.update({ where: { id: h.actor.id }, data: { staffRoleKey: "finance" } });
    await error(h.profile.admin.profile(h.staff, h.owner.store.id), "PERMISSION_DENIED");
  } finally {
    await h.prisma.staffRole.update({
      where: { key: "finance" },
      data: { moduleLevels: { ...levels } },
    });
  }
});

it("十二免审字段同批一次版本/代理审计/事件，真实GET与完整度消费且重审/联系人保持", async () => {
  const h = await world();
  await installDicts(h);
  const [logo, door, serviceImage] = await Promise.all([h.file(), h.file(), h.file()]);
  const original = await h.prisma.store.findUniqueOrThrow({ where: { id: h.owner.store.id } }),
    result = await h.update({
      ...body(),
      note: "虚构委托",
      brandName: "测试代理品牌",
      logoFileId: logo.id,
      businessHours: [{ start: "09:00", end: "18:00" }],
      storeTel: "010-12345678",
      avgSpendFen: 12345,
      brandIntro: "测试简介",
      promoText: "测试优惠",
      groupBuyText: "测试团购",
      sellingPointCodes: ["SP99"],
      sellingNote: "测试卖点",
      mediaGroups: { door: [{ fileId: door.id }] },
      serviceItems: [
        { name: "测试服务", priceFen: 1000, imageFileId: serviceImage.id, intro: "简介" },
      ],
    });
  expect(result).toMatchObject({
    lockVersion: 1,
    brandName: "测试代理品牌",
    lastEditor: { actorType: "staff", name: h.actor.name },
    serviceItems: [{ name: "测试服务", image: { fileId: serviceImage.id } }],
    media: { door: [{ file: { fileId: door.id } }] },
  });
  expect(result.logo?.url).toBeTruthy();
  expect(result.completeness.requiredFilled).toBeGreaterThan(0);
  const saved = await h.prisma.storeProfile.findUniqueOrThrow({
    where: { storeId: h.owner.store.id },
  });
  expect(saved).toMatchObject({
    lastEditActorType: "staff",
    lastEditActorId: h.actor.id,
    lastEditClient: "admin",
    lockVersion: 1,
    contactName: null,
    contactPhoneEnc: null,
  });
  expect(await h.prisma.store.findUniqueOrThrow({ where: { id: h.owner.store.id } })).toEqual(
    original,
  );
  expect(
    await h.prisma.qualificationSubmission.count({ where: { storeId: h.owner.store.id } }),
  ).toBe(0);
  expect(
    await h.prisma.storeProfileMedia.findFirstOrThrow({ where: { storeId: h.owner.store.id } }),
  ).toMatchObject({ createActorType: "staff", createActorId: h.actor.id, createClient: "admin" });
  const audits = await h.prisma.auditLog.findMany({ where: { storeId: h.owner.store.id } }),
    events = await h.prisma.outboxEvent.findMany({
      where: { storeId: h.owner.store.id, eventType: "store.profile.changed" },
    });
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    stream: "ops",
    onBehalfOfEntityId: h.owner.entity.id,
    reasonCode: "merchant_wecom_request",
    reasonText: "虚构委托",
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    entityId: h.owner.entity.id,
    payload: {
      source: "staff_proxy",
      storeId: h.owner.store.id,
      fields: expect.arrayContaining([...PROXY_EDITABLE_FIELDS]),
    },
  });
  expect((await h.profile.admin.profile(h.staff, h.owner.store.id)).lockVersion).toBe(1);
  expect(
    h.fake.wechat
      .callsOf("checkText")
      .every((call) => (call.input as { openid: string }).openid === h.wx.openid),
  ).toBe(true);
});

it("两独立连接同版本仅一胜；同键回执一次检测/写入且撤权后拒绝旧回执", async () => {
  const h = await world(),
    race = await Promise.allSettled([
      h.update({ ...body(), avgSpendFen: 100 }),
      h.update({ ...body(), avgSpendFen: 200 }),
    ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(race.find((r) => r.status === "rejected")).toMatchObject({
    reason: { error: "VERSION_CONFLICT" },
  });
  expect(
    (await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: h.owner.store.id } }))
      .lockVersion,
  ).toBe(1);
  const another = await world(),
    input = { ...body(), promoText: "测试重放优惠" },
    key = uuidv7(),
    idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.store.profile.update",
        actor: another.identity.actor,
        key,
        request: { method: "PATCH", body: input },
      });
  const first = await another.update(input, { idem: idem() }),
    calls = another.fake.wechat.callsOf("checkText").length;
  expect(await another.update(input, { idem: idem() })).toEqual(first);
  expect(another.fake.wechat.callsOf("checkText")).toHaveLength(calls);
  expect(await counts(another)).toEqual([1, 0, 0, 0, 1, 1]);
  await another.prisma.staff.update({
    where: { id: another.actor.id },
    data: { staffRoleKey: "finance" },
  });
  await error(another.update(input, { idem: idem() }), "PERMISSION_DENIED");
});

it("三类文件替换保留30天/新live引用，污染与不可用文件拒写，签图后失去范围不回传", async () => {
  const h = await world(),
    old = [await h.file(), await h.file(), await h.file()],
    fresh = [await h.file(), await h.file(), await h.file()];
  const first = await h.update({
    ...body(),
    logoFileId: old[0]!.id,
    mediaGroups: { door: [{ fileId: old[1]!.id }] },
    serviceItems: [{ name: "测试服务", priceFen: 100, imageFileId: old[2]!.id }],
  });
  await h.update({
    ...body(1),
    logoFileId: fresh[0]!.id,
    mediaGroups: { door: [{ fileId: fresh[1]!.id }] },
    serviceItems: [
      {
        serviceItemId: first.serviceItems[0]!.serviceItemId,
        name: "测试服务",
        priceFen: 100,
        imageFileId: fresh[2]!.id,
      },
    ],
  });
  const refs = await h.prisma.fileRef.findMany({ where: { storeId: h.owner.store.id } });
  for (const oldFile of old)
    expect(refs.find((r) => r.fileId === oldFile.id)).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 30 * 86400000),
    });
  for (const newFile of fresh)
    expect(refs.find((r) => r.fileId === newFile.id)).toMatchObject({ state: "live" });
  const foreign = await h.newOwner(),
    bad = await h.make.fileObject({
      category: "profile_image",
      bucket: "asset",
      scopeType: "store",
      entityId: foreign.entity.id,
      storeId: foreign.store.id,
      uploadActorType: "staff",
      uploadActorId: h.actor.id,
      uploadClient: "admin",
    });
  const blocked = await h.file(),
    unmarked = await h.file(false);
  await h.prisma.fileObject.update({
    where: { id: blocked.id },
    data: { moderationState: "block" },
  });
  const before = await counts(h);
  for (const id of [bad.id, blocked.id, unmarked.id, uuidv7()])
    await error(h.update({ ...body(2), logoFileId: id }), "FILE_NOT_USABLE");
  expect(await counts(h)).toEqual(before);
  // 原签图缓存按30分钟窗口复用；推进到下一窗口，明确触发一次新签图。
  h.clock.advance(1_800_000);
  h.fake.storage.delayNext("presignGet", 100);
  const reading = h.profile.admin.profile(h.staff, h.owner.store.id);
  const checked = expect(reading).rejects.toMatchObject({ error: "NOT_FOUND" });
  await vi.waitFor(() => expect(h.fake.storage.pendingCalls()).toBe(1), {
    timeout: 2000,
    interval: 5,
  });
  await h.prisma.staff.update({
    where: { id: h.actor.id },
    data: { staffRoleKey: "delivery_manager" },
  });
  h.clock.advance(100);
  h.fake.storage.tick();
  await checked;
});

it("真实openid缺失/Provider失败与命中零写；检测期间版本、owner、权限变化均拒迟到", async () => {
  const h = await world(),
    before = await counts(h);
  await h.prisma.wechatIdentity.update({
    where: { id: h.wx.id },
    data: { lastActiveAt: new Date(h.clock.now().getTime() - 2 * 3600000 - 1) },
  });
  await error(h.update({ ...body(), brandName: "测试品牌" }), "PROVIDER_UNAVAILABLE");
  expect(h.fake.wechat.callsOf("checkText")).toHaveLength(0);
  await h.prisma.wechatIdentity.update({
    where: { id: h.wx.id },
    data: { lastActiveAt: h.clock.now() },
  });
  h.fake.wechat.failNext("checkText");
  await error(h.update({ ...body(), brandName: "测试品牌" }), "PROVIDER_UNAVAILABLE");
  h.fake.wechat.textVerdicts.push("block");
  await error(h.update({ ...body(), brandName: "测试品牌" }), "CONTENT_REJECTED");
  expect(await counts(h)).toEqual(before);
  h.fake.wechat.delayNext("checkText", 100);
  const late = error(h.update({ ...body(), brandName: "迟到品牌" }), "VERSION_CONFLICT");
  await pending(h);
  // 原商家公口消费同一共享应用，仍独立升版本；迟到代理不能覆盖它。
  await h.profile.updateBasic(h.owner.viewer, { draft: true, lockVersion: 0, avgSpendFen: 200 });
  release(h);
  await late;
  expect(
    (await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: h.owner.store.id } }))
      .brandName,
  ).toBeNull();
  const changing = await world();
  changing.fake.wechat.delayNext("checkText", 100);
  const stale = error(
    changing.update({ ...body(), brandName: "旧老板应答" }),
    "PRECONDITION_CHANGED",
  );
  await pending(changing);
  // 合法表约束内替换真实owner事实；不把客户端owner/openid当作授权来源。
  const next = await changing.make.merchantUser();
  await changing.prisma.entityMember.update({
    where: { id: changing.owner.member.id },
    data: { role: "clerk" },
  });
  await changing.make.entityMember({
    entityId: changing.owner.entity.id,
    merchantUserId: next.id,
    role: "owner",
  });
  release(changing);
  await stale;
  expect(await counts(changing)).toEqual([0, 0, 0, 0, 0, 0]);
  const revoked = await world();
  revoked.fake.wechat.delayNext("checkText", 100);
  const noPermission = error(
    revoked.update({ ...body(), brandName: "撤权应答" }),
    "PERMISSION_DENIED",
  );
  await pending(revoked);
  await revoked.prisma.staff.update({
    where: { id: revoked.actor.id },
    data: { staffRoleKey: "finance" },
  });
  release(revoked);
  await noPermission;
  expect(await counts(revoked)).toEqual([0, 0, 0, 0, 0, 0]);
});

it("已提交必填清空拒绝；最后事件写后失败全回滚，旧商家媒体/服务应用仍保原行为", async () => {
  const h = await world(),
    prepared = await complete(h, h.owner.viewer);
  await submit(h, h.owner.viewer, prepared.submissionId);
  const saved = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: h.owner.store.id },
    }),
    before = await counts(h);
  await error(
    h.update({ ...body(saved.lockVersion), brandName: null }),
    "PROFILE_REQUIRED_MISSING",
  );
  await error(
    h.update({ ...body(saved.lockVersion), mediaGroups: { door: [] } }),
    "PROFILE_REQUIRED_MISSING",
  );
  await error(
    h.update({ ...body(saved.lockVersion), serviceItems: [] }),
    "PROFILE_REQUIRED_MISSING",
  );
  expect(await counts(h)).toEqual(before);
  const original = h.events.emit.bind(h.events),
    spy = vi.spyOn(h.events, "emit").mockImplementation(async (tx, ctx, event) => {
      const result = await original(tx, ctx, event);
      if (event.type === "store.profile.changed") throw new Error("lyxtest: 末个事件写后故障");
      return result;
    }),
    replacement = await h.file();
  try {
    await expect(
      h.update({ ...body(saved.lockVersion), logoFileId: replacement.id, promoText: "故障优惠" }),
    ).rejects.toThrow("末个事件写后故障");
  } finally {
    spy.mockRestore();
  }
  expect(await counts(h)).toEqual(before);
  expect(
    await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: h.owner.store.id } }),
  ).toEqual(saved);
  expect((await h.profile.admin.profile(h.staff, h.owner.store.id)).brandName).toBe("测试品牌");
});
