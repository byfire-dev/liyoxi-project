import { expect } from "@playwright/test";
export async function tenantRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const content = () => active("#profile-ready");
  const field = (label) =>
    active(".lyx-field:visible").filter({ hasText: label }).locator("input").first();
  const button = (text) => active(".lyx-button").filter({ hasText: new RegExp(`^${text}$`) });
  const calls = () => page.evaluate(() => globalThis.__LYX_TENANT_CALLS__ ?? []);
  await expect(content()).toBeVisible();
  if (scene === "tenant-stores-owner") {
    await expect(content()).toContainText("主体与额度");
    await expect(content()).toContainText("南山店");
    await expect(button("进入本店")).toHaveCount(2);
    await expect(button("新增门店")).toBeVisible();
    expect((await calls()).some((c) => c.path === "/m/stores" && c.store === false)).toBe(true);
  } else if (scene === "tenant-stores-clerk") {
    await expect(content()).toContainText("南山店");
    await expect(button("新增门店")).toHaveCount(0);
    await expect(content()).not.toContainText("主体与额度");
    await expect(button("删除草稿")).toHaveCount(0);
    await expect(button("停用")).toHaveCount(0);
  } else if (scene === "tenant-store-add") {
    await expect(content()).toContainText("门店额度");
    await expect(active(".lyx-checkbox--checked")).toHaveCount(0);
    await field("门店名称").fill("新建邻里门店");
    await field("街道与门牌号").fill("邻里路18号");
    for (const [field, value] of [
      ["行业", "餐饮"],
      ["品类", "咖啡饮品"],
      ["省份", "广东省"],
      ["城市", "深圳市"],
      ["区县", "福田区"],
    ]) {
      await button(`选择${field}`).click();
      await active(".lyx-sheet:visible .lyx-button")
        .filter({ hasText: new RegExp(`^${value}$`) })
        .click();
    }
    await button("创建并完善档案").click();
    await expect(content()).toContainText("门店已创建");
    await expect(button("继续完善该店档案")).toBeVisible();
    await expect(button("创建并完善档案")).toHaveClass(/lyx-button--disabled/);
    await field("门店名称").fill("改名不应重复创建");
    await expect(button("创建并完善档案")).toHaveClass(/lyx-button--disabled/);
    const creates = (await calls()).filter((c) => c.path === "/m/stores" && c.method === "POST");
    expect(creates).toHaveLength(1);
    expect(creates[0].data).not.toHaveProperty("copyFromStoreId");
    expect(creates[0].key).toBeTruthy();
  } else if (scene === "tenant-staff-profile") {
    await expect(content()).toContainText("小陈");
    await expect(content()).toContainText("我上传的素材");
    await expect(content()).toContainText("补拍手作咖啡过程");
    await expect(content()).not.toContainText("成员名额");
    expect((await calls()).some((c) => c.path === "/m/store-assets/summary?uploader=me")).toBe(
      true,
    );
  } else if (scene === "tenant-members-owner") {
    await expect(content()).toContainText("成员名额");
    await expect(content()).toContainText("小陈");
    await button("所属门店").click();
    await expect(active(".lyx-sheet")).toContainText("南山店");
    await button("保存门店").click();
    await expect(active(".lyx-sheet")).toBeHidden();
    const writes = (await calls()).filter((c) => c.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toEqual({ storeIds: ["00000000-0000-7000-8000-000000000002"] });
    expect(writes[0].key).toBeTruthy();
  } else if (scene === "tenant-invite-owner") {
    await expect(button("发送给微信好友")).toBeVisible();
    await field("对方手机号（按要求填写）").fill("13900009000");
    await expect(button("发送给微信好友")).toHaveClass(/lyx-button--disabled/);
    await button("保存邀请内容").click();
    await expect(content()).toContainText("限指定手机号");
    const drafts = (await calls()).filter((c) => c.path === "/m/invitations");
    expect(drafts).toHaveLength(2);
    expect(drafts[0].key).toBeUndefined();
    expect(drafts[1].data.clientRequestId).not.toBe(drafts[0].data.clientRequestId);
    await button("撤回邀请").click();
    await expect(content()).toContainText("邀请已撤回");
    expect((await calls()).some((c) => c.path.endsWith("/accept"))).toBe(false);
  } else if (scene === "tenant-join-pending") {
    await expect(content()).toContainText("邀请你加入门店");
    await expect(content()).toContainText("商家服务协议");
    await expect(button("手机号快捷验证并加入")).toHaveClass(/lyx-button--disabled/);
    await active(".lyx-checkbox").click();
    await expect(button("手机号快捷验证并加入")).not.toHaveClass(/lyx-button--disabled/);
    expect((await calls()).find((c) => c.path.startsWith("/m/invitations/lookup?"))).toMatchObject({
      auth: false,
      store: false,
    });
    expect((await calls()).some((c) => c.path.endsWith("/accept"))).toBe(false);
  } else if (scene === "tenant-join-expired") {
    await expect(content()).toContainText("邀请已过期");
    await expect(button("接受邀请并加入")).toHaveCount(0);
    await expect(button("手机号快捷验证并加入")).toHaveCount(0);
    await expect(button("查看我的门店")).toBeVisible();
  }
}
