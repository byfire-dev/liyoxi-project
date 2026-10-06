import { beforeAll, describe, expect, it } from "vitest";
import { createIdempotencyContext } from "../kernel/index.js";
import { openSealed, useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("保存前内容检测", () => {
  it("Unavailable 与命中均不写业务数据，Provider 严格事务外", async () => {
    const { viewer } = await h.owner();
    h.fake.wechat.failNext("checkText");
    await expect(
      h.profile.updateBasic(viewer, { draft: true, lockVersion: 0, brandName: "测试品牌" }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(
      await h.prisma.storeProfile.findUnique({ where: { storeId: viewer.membership.storeId } }),
    ).toBeNull();
    h.fake.wechat.textVerdicts.push("block");
    await expect(
      h.profile.updateBasic(viewer, { draft: true, lockVersion: 0, brandName: "测试品牌" }),
    ).rejects.toMatchObject({ error: "CONTENT_REJECTED", details: { fields: ["brandName"] } });
    expect(await h.prisma.storeProfile.count()).toBe(0);
  });
  it("done 重放不再次检测", async () => {
    const { viewer } = await h.owner(),
      body = { draft: true, lockVersion: 0, brandName: "有效品牌" };
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "m.storeProfile.basic.update",
        actor: viewer.ctx.actor,
        key: "profile-content-replay",
        request: { method: "PATCH", body },
      });
    const first = await h.profile.updateBasic(viewer, body, { idem: idem() });
    const count = h.fake.wechat.callsOf("checkText").length;
    const replay = await h.profile.updateBasic(viewer, body, { idem: idem() });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(h.fake.wechat.callsOf("checkText")).toHaveLength(count);
    expect(
      (
        await h.prisma.storeProfile.findUniqueOrThrow({
          where: { storeId: viewer.membership.storeId },
        })
      ).lockVersion,
    ).toBe(1);
  });
  it("检测应答期间版本变化，settle 重读拒写", async () => {
    const { viewer } = await h.owner();
    h.fake.wechat.delayNext("checkText", 100);
    const save = h.profile.updateBasic(viewer, {
      draft: true,
      lockVersion: 0,
      brandName: "迟到品牌",
    });
    while (h.fake.wechat.pendingCalls() === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await h.profile.updateMedia(viewer, { draft: true, lockVersion: 0, groups: { door: [] } });
    h.clock.advance(100);
    h.fake.wechat.tick();
    await expect(save).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    expect(
      (
        await h.prisma.storeProfile.findUniqueOrThrow({
          where: { storeId: viewer.membership.storeId },
        })
      ).brandName,
    ).toBeNull();
  });
  it("登录手机号跨 AAD 重新加密，响应仅 mask", async () => {
    const { viewer, user } = await h.owner();
    const result = await h.profile.updateContact(viewer, {
      lockVersion: 0,
      name: "联系人",
      phoneSource: "login",
    });
    const p = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: viewer.membership.storeId },
    });
    expect(() => openSealed("store_profile.contact_phone_enc", user.phoneEnc!)).toThrow();
    expect(openSealed("store_profile.contact_phone_enc", p.contactPhoneEnc!)).toBe(
      openSealed("merchant_user.phone_enc", user.phoneEnc!),
    );
    expect(result.phoneMask).toBe(user.phoneMask);
    expect(result.phoneVerifyState).toBe("login");
    expect(JSON.stringify(result)).not.toContain(
      openSealed("merchant_user.phone_enc", user.phoneEnc!),
    );
  });
});
it.each(["service", "contact"] as const)("%s 成功同键重放也不再次内容检测", async (kind) => {
  const { viewer } = await h.owner();
  const body =
    kind === "service"
      ? { draft: true, lockVersion: 0, promoText: "优惠介绍" }
      : { lockVersion: 0, name: "测试联系人", phoneSource: "login" as const };
  const scope =
    kind === "service" ? "m.storeProfile.service.update" : "m.storeProfile.contact.update";
  const idem = () =>
    createIdempotencyContext({
      mode: "required",
      scope,
      actor: viewer.ctx.actor,
      key: `profile-content-${kind}`,
      request: { method: "PATCH", body },
    });
  const run = () =>
    kind === "service"
      ? h.profile.updateService(
          viewer,
          { draft: true, lockVersion: 0, promoText: "优惠介绍" },
          { idem: idem() },
        )
      : h.profile.updateContact(
          viewer,
          { lockVersion: 0, name: "测试联系人", phoneSource: "login" },
          { idem: idem() },
        );
  await run();
  const count = h.fake.wechat.callsOf("checkText").length;
  expect(await run()).toMatchObject({ replayed: true });
  expect(h.fake.wechat.callsOf("checkText")).toHaveLength(count);
});
it("基础信息必填守卫先于清空门店名称的 tenant 写入口", async () => {
  const { viewer, store } = await h.owner();
  await expect(
    h.profile.updateBasic(viewer, { draft: false, lockVersion: 0, storeName: null }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  expect((await h.prisma.store.findUniqueOrThrow({ where: { id: store.id } })).name).toBe(
    store.name,
  );
  expect(await h.prisma.storeProfile.findUnique({ where: { storeId: store.id } })).toBeNull();
  await h.profile.updateBasic(viewer, { draft: true, lockVersion: 0, storeName: null });
  expect((await h.prisma.store.findUniqueOrThrow({ where: { id: store.id } })).name).toBeNull();
  const rejected = await h.make.store({
    qualificationStatus: "rejected",
    entityId: viewer.membership.entityId,
  });
  await expect(
    h.profile.updateBasic(
      { ...viewer, membership: { ...viewer.membership, storeId: rejected.id } },
      { draft: true, lockVersion: 0, storeName: null },
    ),
  ).rejects.toMatchObject({ error: "PROFILE_REQUIRED_MISSING" });
});
