import { expect } from "@playwright/test";

const field = (page, label) =>
  page.locator(".lyx-field:visible").filter({ hasText: label }).locator("input").first();
const button = (page, label) => page.locator(".lyx-button:visible").filter({ hasText: label });
const conflict = "资料已更新，已保留本次输入。请先刷新核对，再保存";
const declaration = (page) =>
  page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" });
async function confirmDeclaration(page) {
  await declaration(page).click();
  await expect(declaration(page)).toHaveClass(/lyx-checkbox--checked/);
  await expect(button(page, "提交资质审核")).not.toHaveClass(/lyx-button--disabled/);
}
export async function profilePageReady(page, kind) {
  // Taro 的导航 Promise/URL 先于转场结束，连续导航必须等目标页真正驻留。
  const active = page.locator(
    `.taro_page[id*="sub/profile/${kind}/index"].taro_page_stationed:not(.taro_page_shade)`,
  );
  await expect(active.locator("#profile-ready")).toBeVisible();
  if (kind === "store")
    await expect(active.getByText("店内环境", { exact: true }).last()).toBeVisible();
  else if (kind === "review")
    await expect(active.getByText("审核进度", { exact: true })).toBeVisible();
  else if (kind === "profile")
    await expect(active.getByText("建档完成度", { exact: true })).toBeVisible();
  else
    await expect(
      field(page, { basic: "品牌名称", service: "优惠活动", cert: "联系人姓名" }[kind]),
    ).toBeVisible();
}

export async function profileCertificateSheetRegression(page, screenshot) {
  await profilePageReady(page, "cert");
  const card = page.locator(".lyx-card").filter({
    has: page.locator(".lyx-card__title").getByText("营业执照", { exact: true }),
  });
  await card.locator(".lyx-button").filter({ hasText: "核对并填写信息" }).click();
  const sheet = page.locator(".profile-certificate-sheet:visible");
  const body = sheet.locator(".lyx-sheet__body");
  const footer = sheet.locator(".lyx-sheet__footer");
  await expect(sheet.locator(".lyx-sheet__title")).toHaveText("填写营业执照");
  await expect(footer).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      sheet.evaluate((node) => !node.closest(".nut-popup")?.className.includes("enter-active")),
    )
    .toBe(true);
  const initial = await body.evaluate((node) => ({
    height: node.clientHeight,
    contentHeight: node.scrollHeight,
    top: node.scrollTop,
  }));
  expect(initial.height).toBeGreaterThan(100);
  expect(initial.height).toBeLessThanOrEqual(page.viewportSize().height * 0.6 + 1);
  expect(initial.contentHeight).toBeGreaterThan(initial.height);
  expect(initial.top).toBe(0);
  const background = page.locator('.taro_page[id*="sub/profile/cert/index"]');
  const backgroundTop = await background.evaluate((node) => node.scrollTop);
  const input = (label) =>
    sheet.locator(".lyx-field").filter({ hasText: label }).locator("input").first();
  const option = (label) => sheet.locator(".lyx-checkbox").filter({ hasText: label });
  const reachable = async (control) => {
    const [bounds, target, fixed] = await Promise.all([
      body.boundingBox(),
      control.boundingBox(),
      footer.boundingBox(),
    ]);
    return Boolean(
      bounds &&
      target &&
      fixed &&
      target.x >= bounds.x - 1 &&
      target.x + target.width <= bounds.x + bounds.width + 1 &&
      target.y >= bounds.y - 1 &&
      target.y + target.height <= Math.min(bounds.y + bounds.height, fixed.y) + 1,
    );
  };
  // fill/click 可替测试自动滚动；每次操作前必须先用用户滚轮把控件完整露出来。
  const scrollTo = async (control) => {
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await reachable(control)) return;
      const bounds = await body.boundingBox();
      const target = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(target).not.toBeNull();
      const before = await body.evaluate((node) => node.scrollTop);
      const direction = target.y < bounds.y ? -1 : 1;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, direction * Math.min(180, bounds.height * 0.65));
      await expect.poll(() => body.evaluate((node) => node.scrollTop)).not.toBe(before);
    }
    expect(await reachable(control), "真实滚动后证照字段须完整露出且不被底栏遮挡").toBe(true);
  };
  const address = input("注册地址");
  const scope = input("经营范围");
  expect(await reachable(address), "小屏幕下底部字段起初应在正文可视区外").toBe(false);
  expect(await reachable(option("分支机构"))).toBe(false);
  const values = {
    address: "广东省深圳市福田区小屏测试路28号",
    businessScope: "咖啡饮品、点心制作与销售",
    principalRole: "operator",
    subjectType: "individual",
  };
  await scrollTo(address);
  await address.fill(values.address);
  await expect(address).toHaveValue(values.address);
  await scrollTo(scope);
  await scope.fill(values.businessScope);
  await expect(scope).toHaveValue(values.businessScope);
  await scrollTo(option("经营者"));
  await option("经营者").click();
  await expect(option("经营者")).toHaveClass(/lyx-checkbox--checked/);
  await scrollTo(option("个体工商户"));
  await option("个体工商户").click();
  await expect(option("个体工商户")).toHaveClass(/lyx-checkbox--checked/);
  await scrollTo(option("分支机构"));
  expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(initial.top);
  expect(await background.evaluate((node) => node.scrollTop)).toBe(backgroundTop);
  await expect(footer).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: screenshot });
  const bottom = await body.evaluate((node) => node.scrollTop);
  const bounds = await body.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -180);
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(bottom);
  expect(await background.evaluate((node) => node.scrollTop)).toBe(backgroundTop);
  await footer.locator(".lyx-button").filter({ hasText: "保存核对信息" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card.getByText(`注册地址：${values.address}`, { exact: true })).toBeVisible();
  await expect(card.getByText(`经营范围：${values.businessScope}`, { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => globalThis.__LYX_PROFILE_CALLS__);
  const writes = calls.filter((call) => call.path.startsWith("/m/qualification-docs/"));
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("PATCH");
  expect(writes[0].path).toBe("/m/qualification-docs/00000000-0000-4000-8000-000000000020");
  expect(writes[0].data).toEqual({ lockVersion: 1, fields: values });
  expect(writes[0].idempotencyKey).toBeTruthy();
  expect(
    calls
      .slice(calls.indexOf(writes[0]) + 1)
      .some((call) => call.path === "/m/store-profile/qualification" && call.method === "GET"),
  ).toBe(true);
}
async function refreshConflict(page, path, save) {
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.conflict(path), path);
  await save.click();
  await expect(page.getByText(conflict, { exact: true })).toBeVisible();
  await page.locator(".lyx-text-button").filter({ hasText: "刷新并核对" }).click();
  await expect(page.locator("#profile-ready")).toBeVisible();
}
export async function profileEditRegression(page, scene) {
  const kind = scene.split("-")[0];
  const path = `/m/store-profile/${kind === "store" ? "media" : kind}`;
  await expect(button(page, "保存并下一步")).toBeVisible();
  const save = button(page, "保存草稿");
  const interior = page.locator(".lyx-card").filter({ hasText: "店内环境" });
  if (kind === "basic") {
    await field(page, "品牌名称").fill("  刷新仍保留的品牌  ");
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.lockBasic());
  }
  if (kind === "store") await interior.locator(".lyx-upload-grid__remove").first().click();
  if (kind === "service") {
    await page
      .locator(".profile-row")
      .first()
      .locator(".lyx-text-button")
      .filter({ hasText: "编辑" })
      .click();
    await field(page, "服务名称").fill("刷新仍保留的服务");
    await button(page, "保存本项").click();
    await field(page, "优惠活动").fill("刷新仍保留的优惠");
  }
  await refreshConflict(page, path, save);
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("  刷新仍保留的品牌  ");
  if (kind === "store") await expect(interior.locator(".lyx-upload-grid__remove")).toHaveCount(2);
  if (kind === "service") {
    await expect(page.getByText("刷新仍保留的服务", { exact: true })).toBeVisible();
    await expect(field(page, "优惠活动")).toHaveValue("刷新仍保留的优惠");
  }
  if (kind === "basic") await expect(field(page, "门店名称")).toBeDisabled();
  const before = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__.filter(
        (call) => call.path === path && call.method === "PATCH",
      ).length,
    path,
  );
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.replay(path), path);
  await save.click();
  await expect(page.getByText(conflict, { exact: true })).toHaveCount(0);
  await expect(page.locator(".lyx-button--loading")).toHaveCount(0);
  const writes = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__.filter(
        (call) => call.path === path && call.method === "PATCH",
      ),
    path,
  );
  expect(writes).toHaveLength(before + 1);
  expect(writes.at(-1).data.draft).toBe(true);
  expect(writes.at(-1).data.lockVersion).toBe(3);
  expect(writes.at(-1).idempotencyKey).not.toBe(writes.at(-2).idempotencyKey);
  const calls = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__
        .filter((call) => call.path === path)
        .map((call) => call.method),
    path,
  );
  expect(calls.slice(-2)).toEqual(["PATCH", "GET"]);
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("刷新仍保留的品牌");
  await expect(
    page.locator(kind === "service" ? ".profile-photo img" : ".lyx-upload-grid__cell img").first(),
  ).toHaveAttribute("src", /data:image/);
  await profileNextRegression(page, kind);
  await profileContextRegression(page, kind);
}

async function profileNextRegression(page, kind) {
  const path = `/m/store-profile/${kind === "store" ? "media" : kind}`;
  const next = button(page, "保存并下一步");
  const route = new RegExp(`sub/profile/${kind}/index`);
  const destination = { basic: "store", store: "service", service: "cert" }[kind];
  const writes = () =>
    page.evaluate(
      (path) =>
        globalThis.__LYX_PROFILE_CALLS__.filter(
          (call) => call.path === path && call.method === "PATCH",
        ),
      path,
    );
  const enter = async () => {
    await page.evaluate(
      (kind) => globalThis.__LYX_PROFILE_CONTROL__.authorization.enter(kind),
      kind,
    );
    await expect(page).toHaveURL(route);
    await profilePageReady(page, kind);
  };

  // 真实输入缺项仍留当前步骤，草稿保存不承担“已完成”的判断。
  if (kind === "basic") await field(page, "品牌名称").fill("");
  if (kind === "service") {
    const checked = page.locator(".lyx-checkbox--checked");
    while (await checked.count()) await checked.first().click();
  }
  await next.click();
  await expect(page.getByText("请补齐本步必填资料再继续", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(route);
  expect((await writes()).at(-1).data.draft).toBe(false);
  if (kind === "basic") await field(page, "品牌名称").fill("刷新仍保留的品牌");
  if (kind === "store") {
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.switchStore());
    await expect(page.locator("#profile-ready")).toBeVisible();
    await expect(
      page.locator(".lyx-card").filter({ hasText: "店内环境" }).locator(".lyx-upload-grid__remove"),
    ).toHaveCount(3);
  }
  if (kind === "service")
    await page.locator(".lyx-checkbox").filter({ hasText: "每日现做" }).click();

  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.failNext(path), path);
  await next.click();
  await expect(page.getByText("离线保存失败，请重试", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(route);

  const beforeNavigation = (await writes()).length;
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.failNextRedirect());
  await next.click();
  await expect(
    page.getByText("资料已保存，页面跳转失败，请点击下方重试", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(route);
  expect((await writes()).length).toBe(beforeNavigation + 1);
  await page.locator(".lyx-text-button").filter({ hasText: "重新进入下一步" }).click();
  await expect(page).toHaveURL(new RegExp(`sub/profile/${destination}/index`));
  await profilePageReady(page, destination);
  expect((await writes()).length).toBe(beforeNavigation + 1);
  await enter();

  // 延迟真实 PATCH 的回包，让双击发生于同一次保存意图尚未结束时。
  const before = (await writes()).length;
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.hold(path), path);
  await next.dblclick();
  await expect.poll(async () => (await writes()).length).toBe(before + 1);
  await expect(page).toHaveURL(route);
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.release(path), path);
  await expect(page).toHaveURL(new RegExp(`sub/profile/${destination}/index`));
  await profilePageReady(page, destination);
  expect((await writes()).length).toBe(before + 1);
  expect((await writes()).at(-1).data.draft).toBe(false);
  await enter();

  for (const interruption of ["switchStore", "leave", ...(kind === "store" ? ["logout"] : [])]) {
    const count = (await writes()).length;
    await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.hold(path), path);
    await next.click();
    await expect.poll(async () => (await writes()).length).toBe(count + 1);
    await page.evaluate(async (interruption) => {
      const control = globalThis.__LYX_PROFILE_CONTROL__;
      if (interruption === "leave") await control.authorization.leave();
      else control[interruption]();
    }, interruption);
    const expected = interruption === "leave" ? /sub\/profile\/review\/index/ : route;
    await expect(page).toHaveURL(expected);
    await profilePageReady(page, interruption === "leave" ? "review" : kind);
    await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.release(path), path);
    await expect.poll(() => page.locator(".lyx-button--loading").count()).toBe(0);
    await expect(page).toHaveURL(expected);
    if (interruption === "leave") await enter();
  }
}
export async function profileContactRegression(page) {
  const path = "/m/store-profile/contact";
  await field(page, "联系人姓名").fill("刷新仍保留的联系人");
  await page.locator(".lyx-checkbox").filter({ hasText: "使用其他号码" }).click();
  await field(page, "联系人手机号").fill("13700130000");
  const save = button(page, "保存联系人");
  await refreshConflict(page, path, save);
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  await expect(field(page, "联系人手机号")).toHaveValue("13700130000");
  await save.click();
  await expect(page.locator(".lyx-button--loading")).toHaveCount(0);
  await expect(page.locator("#profile-ready")).toBeVisible();
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  const writes = await page.evaluate(() =>
    globalThis.__LYX_PROFILE_CALLS__.filter(
      (call) => call.path === "/m/store-profile/contact" && call.method === "PATCH",
    ),
  );
  expect(writes.map((call) => call.data.lockVersion)).toEqual([1, 2]);
  expect(writes[1].data.phone).toBe("13700130000");
}
export async function profileAuthorizationRegression(page) {
  const start = async () => {
    const declaration = page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" });
    if (!(await declaration.getAttribute("class"))?.includes("lyx-checkbox--checked"))
      await declaration.click();
    await expect(declaration).toHaveClass(/lyx-checkbox--checked/);
    await expect(button(page, "提交资质审核")).not.toHaveClass(/lyx-button--disabled/);
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.defer());
    await button(page, "提交资质审核").dblclick();
    await expect
      .poll(() => page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.asks()))
      .toBe(1);
  };
  const settle = async () => {
    const before = await page.evaluate(() => ({
      calls: globalThis.__LYX_PROFILE_CALLS__.length,
      url: globalThis.location.href,
    }));
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.settle());
    expect(await page.evaluate(() => globalThis.__LYX_PROFILE_CALLS__.length)).toBe(before.calls);
    expect(page.url()).toBe(before.url);
    expect(
      await page.evaluate(() =>
        globalThis.__LYX_PROFILE_CALLS__.filter((call) =>
          call.path.endsWith("/qualification/submit"),
        ),
      ),
    ).toEqual([]);
  };
  await start();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.leave());
  await expect(page).toHaveURL(/sub\/profile\/review\/index/);
  await profilePageReady(page, "review");
  await settle();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.enter());
  await expect(page).toHaveURL(/sub\/profile\/cert\/index/);
  await profilePageReady(page, "cert");
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  await start();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.hide());
  await expect(page).toHaveURL(/sub\/profile\/review\/index/);
  await profilePageReady(page, "review");
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.back());
  await expect(page).toHaveURL(/sub\/profile\/cert\/index/);
  await profilePageReady(page, "cert");
  await expect(button(page, "提交资质审核")).toBeVisible();
  await expect(button(page, "提交资质审核")).not.toHaveClass(/lyx-button--loading/);
  await expect(
    page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" }),
  ).not.toHaveClass(/lyx-checkbox--checked/);
  await settle();
  await start();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.switchStore());
  await expect(field(page, "联系人姓名")).toHaveValue("新门店联系人");
  await expect(page.locator("#profile-ready")).toBeVisible();
  await settle();
  await expect(button(page, "提交资质审核")).not.toHaveClass(/lyx-button--loading/);
  await expect(page.locator(".lyx-checkbox").filter({ hasText: "我确认所填信息" })).not.toHaveClass(
    /lyx-checkbox--checked/,
  );
}
export async function profileContextRegression(page, kind) {
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.switchStore());
  await expect(page.locator("#profile-ready")).toBeVisible();
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("新门店品牌");
  if (kind === "store")
    await expect(
      page.locator(".lyx-card").filter({ hasText: "店内环境" }).locator(".lyx-upload-grid__remove"),
    ).toHaveCount(3);
  if (kind === "service") {
    await expect(page.getByText("新门店服务", { exact: true })).toBeVisible();
    await expect(field(page, "优惠活动")).not.toHaveValue("刷新仍保留的优惠");
  }
  if (kind === "cert") await expect(field(page, "联系人姓名")).toHaveValue("新门店联系人");
  const label =
    kind === "basic"
      ? "品牌名称"
      : kind === "service"
        ? "优惠活动"
        : kind === "cert"
          ? "联系人姓名"
          : null;
  if (label) {
    await field(page, label).fill("登出应清理的草稿");
    const path = ["basic", "service"].includes(kind) ? `/m/store-profile/${kind}` : null;
    const currentUrl = page.url();
    if (path) {
      const before = await page.evaluate(() => globalThis.__LYX_PROFILE_CALLS__.length);
      await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.hold(path), path);
      await button(page, "保存并下一步").click();
      await expect
        .poll(() => page.evaluate(() => globalThis.__LYX_PROFILE_CALLS__.length))
        .toBeGreaterThan(before);
      // 旧门店保存已发生；下一上下文的读视图独立于被暂停的旧响应快照。
      await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.replaceStore());
    }
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.logout());
    if (path) {
      await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.release(path), path);
      await expect(page.locator(".lyx-button--loading:visible")).toHaveCount(0);
      expect(page.url()).toBe(currentUrl);
    }
    await expect(field(page, label)).not.toHaveValue("登出应清理的草稿");
  }
}

export async function profileMissingRegression(page, scene) {
  const enter = async (kind) => {
    await page.evaluate(
      (kind) => globalThis.__LYX_PROFILE_CONTROL__.authorization.enter(kind),
      kind,
    );
    await profilePageReady(page, kind);
  };
  const row = (title) => page.locator(".lyx-list-row:visible").filter({ hasText: title });
  if (scene === "profile-missing-items") {
    await expect(row("主推服务").getByText("需补充：核心卖点标签", { exact: true })).toBeVisible();
    await expect(row("资质认证").getByText("需补充：信息确认", { exact: true })).toBeVisible();
    await row("主推服务").click();
    await profilePageReady(page, "service");
    await page.locator(".lyx-checkbox:visible").filter({ hasText: "每日现做" }).click();
    await button(page, "保存草稿").click();
    await expect(button(page, "保存草稿")).not.toHaveClass(/lyx-button--loading/);
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.back());
    await profilePageReady(page, "profile");
    await expect(row("主推服务").getByText("已完成", { exact: true }).first()).toBeVisible();
    await row("资质认证").click();
    await profilePageReady(page, "cert");
    await confirmDeclaration(page);
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.back());
    await profilePageReady(page, "profile");
    await expect(row("资质认证").getByText("已完成", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("已完成 16/16 项必填资料", { exact: true })).toBeVisible();
    return;
  }
  if (scene.startsWith("service-")) {
    await expect(
      page.getByText("至少选择1个标签，最多5个，候选按门店品类提供", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "暂无可选的核心卖点标签，请联系平台配置后再继续。填写补充卖点不能代替标签选择，可先保存草稿。",
        { exact: true },
      ),
    ).toBeVisible();
    await field(page, "补充卖点").fill("文字不能代替标签");
    await button(page, "保存草稿").click();
    await expect(button(page, "保存草稿")).not.toHaveClass(/lyx-button--loading/);
    const last = await page.evaluate(() =>
      globalThis.__LYX_PROFILE_CALLS__.filter((call) => call.method === "PATCH").at(-1),
    );
    expect(last.data.sellingPointCodes).toEqual([]);
    expect(last.data.sellingNote).toBe("文字不能代替标签");
    await button(page, "保存并下一步").click();
    await expect(page.getByText("请补齐本步必填资料再继续", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/sub\/profile\/service\/index/);
    return;
  }
  const path = "/m/store-profile/qualification";
  const writes = () =>
    page.evaluate(
      (path) =>
        globalThis.__LYX_PROFILE_CALLS__.filter(
          (call) => call.path === path && call.method === "PATCH",
        ),
      path,
    );
  await expect(declaration(page)).not.toHaveClass(/lyx-checkbox--checked/);
  await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.failNext(path), path);
  await declaration(page).click();
  await expect(page.getByText("离线保存失败，请重试", { exact: true })).toBeVisible();
  await expect(declaration(page)).not.toHaveClass(/lyx-checkbox--checked/);
  await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);
  await enter("profile");
  await expect(row("资质认证").getByText("需补充：信息确认", { exact: true })).toBeVisible();
  await enter("cert");

  const before = (await writes()).length;
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.hold(path), path);
  await declaration(page).dblclick();
  await expect.poll(async () => (await writes()).length).toBe(before + 1);
  await expect(declaration(page)).toHaveClass(/lyx-checkbox--disabled/);
  await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);
  await button(page, "提交资质审核").click();
  expect(
    await page.evaluate(
      () => globalThis.__LYX_PROFILE_CALLS__.filter((call) => call.path.endsWith("/submit")).length,
    ),
  ).toBe(0);
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.release(path), path);
  await expect(declaration(page)).toHaveClass(/lyx-checkbox--checked/);
  expect((await writes()).at(-1).data).toEqual({
    lockVersion: 1,
    declarationConfirmed: true,
    declarationVersion: "1",
  });
  await declaration(page).click();
  await expect(declaration(page)).not.toHaveClass(/lyx-checkbox--disabled/);
  expect((await writes()).at(-1).data).toEqual({ lockVersion: 2, declarationConfirmed: false });
  await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);
  await confirmDeclaration(page);
  await enter("profile");
  await expect(row("资质认证").getByText("已完成", { exact: true }).first()).toBeVisible();
  await enter("cert");
  await expect(declaration(page)).not.toHaveClass(/lyx-checkbox--checked/);
  await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);

  for (const advance of [
    "advanceDeclaration",
    "advanceRound",
    "advanceRoundVersion",
    "submitElsewhere",
  ]) {
    const count = (await writes()).length;
    await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.hold(path), path);
    await declaration(page).click();
    await expect.poll(async () => (await writes()).length).toBe(count + 1);
    await page.evaluate(async (advance) => {
      globalThis.__LYX_PROFILE_CONTROL__[advance]();
      await globalThis.__LYX_PROFILE_CONTROL__.authorization.refresh();
    }, advance);
    const checkLatest = async () => {
      if (advance === "advanceDeclaration")
        await expect(page.getByText("确认版本：2", { exact: true })).toBeVisible();
      if (advance === "advanceRound")
        await expect(field(page, "联系人姓名")).toHaveValue("新轮次联系人");
      if (advance === "advanceRoundVersion")
        await expect(
          page.locator(".lyx-checkbox:visible").filter({ hasText: "个体工商户" }),
        ).toHaveClass(/lyx-checkbox--checked/);
      if (advance === "submitElsewhere") {
        await expect(
          page.getByText("当前证照与声明只读，联系人仍可保存。审核进度与结果请到审核进度页查看", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(declaration(page)).toHaveCount(0);
        await expect(button(page, "提交资质审核")).toHaveCount(0);
        await expect(button(page, "核对并填写信息")).toHaveCount(0);
        await expect(button(page, "从本轮移除")).toHaveCount(0);
        await expect(page.locator(".lyx-upload-grid:visible")).toHaveCount(0);
        for (const label of ["企业", "个体工商户"])
          await expect(
            page.locator(".profile-pair .lyx-checkbox:visible").filter({ hasText: label }),
          ).toHaveClass(/lyx-checkbox--disabled/);
        expect(await writes()).toHaveLength(count + 1);
      }
    };
    await checkLatest();
    await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.release(path), path);
    await expect(page.locator(".lyx-button--loading:visible")).toHaveCount(0);
    await checkLatest();
    if (advance === "submitElsewhere") {
      // 联系人独立于在审轮次；旧声明回包不能恢复证照写入口，保存联系人也不改审核快照。
      const beforeContact = await page.evaluate(() => ({
        state: globalThis.__LYX_PROFILE_CONTROL__.qualificationState(),
        calls: globalThis.__LYX_PROFILE_CALLS__.length,
      }));
      expect(beforeContact.state.storeQualificationStatus).toBe("pending");
      expect(beforeContact.state.openRound.phase).toBe("in_review");
      expect(beforeContact.state.openRound.contactSnapshot).toEqual({
        name: beforeContact.state.contact.name,
        phoneMask: beforeContact.state.contact.phoneMask,
        phoneVerifyState: beforeContact.state.contact.phoneVerifyState,
      });
      await expect(field(page, "联系人姓名")).toBeEnabled();
      await field(page, "联系人姓名").fill("审核中更新联系人");
      const save = button(page, "保存联系人");
      await expect(save).not.toHaveClass(/lyx-button--disabled/);
      await save.click();
      await expect(save).not.toHaveClass(/lyx-button--loading/);
      await expect(field(page, "联系人姓名")).toHaveValue("审核中更新联系人");
      await expect
        .poll(() =>
          page.evaluate(
            (from) =>
              globalThis.__LYX_PROFILE_CALLS__
                .slice(from)
                .some(
                  (call) => call.path === "/m/store-profile/qualification" && call.method === "GET",
                ),
            beforeContact.calls,
          ),
        )
        .toBe(true);
      await profilePageReady(page, "cert");
      const afterContact = await page.evaluate(
        (from) => ({
          state: globalThis.__LYX_PROFILE_CONTROL__.qualificationState(),
          calls: globalThis.__LYX_PROFILE_CALLS__.slice(from),
        }),
        beforeContact.calls,
      );
      expect(afterContact.calls.filter((call) => call.method !== "GET")).toEqual([
        {
          path: "/m/store-profile/contact",
          method: "PATCH",
          data: {
            lockVersion: beforeContact.state.contact.lockVersion,
            name: "审核中更新联系人",
            phoneSource: "login",
          },
          idempotencyKey: expect.any(String),
        },
      ]);
      expect(afterContact.calls.some((call) => call.path === path && call.method === "GET")).toBe(
        true,
      );
      expect(afterContact.state.contact.name).toBe("审核中更新联系人");
      expect(afterContact.state.openRound).toEqual(beforeContact.state.openRound);
      expect(afterContact.state.storeQualificationStatus).toBe("pending");
      await checkLatest();
    } else {
      await expect(declaration(page)).not.toHaveClass(/lyx-checkbox--checked/);
      await expect(button(page, "提交资质审核")).toHaveClass(/lyx-button--disabled/);
    }
  }
}
