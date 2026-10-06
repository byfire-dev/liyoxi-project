async function disabled(button) {
  return (await button.getAttribute("class"))?.includes("lyx-button--disabled");
}
export async function orderRegression(page, scene) {
  if (scene.startsWith("checkout-")) {
    const submit = page.locator(".checkout-page .lyx-footer-bar .lyx-button");
    if (!(await disabled(submit))) throw new Error("未完成账号、重点与协议不能提交");
    await page
      .locator(".checkout-page .lyx-checkbox")
      .filter({ hasText: "抖音 · 邻里咖啡" })
      .click();
    await page.locator("#order-ready").waitFor({ state: "visible" });
    await page.locator(".checkout-page .lyx-chip").filter({ hasText: "主推服务" }).click();
    await page
      .locator(".checkout-page .lyx-checkbox")
      .filter({ hasText: "我已阅读并同意本次协议" })
      .click();
    if (["checkout-points", "checkout-qualification"].includes(scene)) {
      if (!(await disabled(submit))) throw new Error("服务端阻断项必须锁住提交");
      const creates = await page.evaluate(
        () =>
          globalThis.__LYX_ORDER_CALLS__.filter(
            (c) => c.method === "POST" && c.path === "/m/orders",
          ).length,
      );
      if (creates !== 0) throw new Error("阻断态发出了create");
      return;
    }
    if (await disabled(submit)) throw new Error("完整有效意图未开放提交");
    await submit.click();
    if (scene === "checkout-quote-changed") {
      await page
        .getByText("报价已更新，请重新核对并同意协议", { exact: true })
        .waitFor({ state: "visible" });
      await page.locator("#order-ready").waitFor({ state: "visible" });
      if (!(await disabled(submit))) throw new Error("报价刷新后未重新勾选协议");
      await page
        .locator(".checkout-page .lyx-checkbox")
        .filter({ hasText: "我已阅读并同意本次协议" })
        .click();
    } else
      await page.getByText("网络暂时中断，请重试", { exact: true }).waitFor({ state: "visible" });
    await submit.click();
    await page.getByText("订购成功", { exact: true }).waitFor({ state: "visible" });
    const calls = await page.evaluate(() => globalThis.__LYX_ORDER_CALLS__);
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/m/orders");
    if (creates.length !== 2) throw new Error("订购重试次数不符");
    if (
      scene === "checkout-quote-changed"
        ? creates[0].key === creates[1].key || creates[1].data.expect.totalChargePoints !== 990
        : creates[0].key !== creates[1].key
    )
      throw new Error("同意图同key/报价变化新key不成立");
    if (
      creates.some((c) => c.data.adIds !== undefined || c.data.referenceStoreAssetIds !== undefined)
    )
      throw new Error("隐藏范围进入提交体");
    if (
      calls.filter((c) => c.method === "GET" && c.path.startsWith("/m/orders/")).length < 2 ||
      !calls.some((c) => c.path === "/m/cart-items")
    )
      throw new Error("C50成功后未读取真实订单与选剧单");
  }
  if (scene === "orders-default") {
    await page.locator(".orders-page .lyx-button").filter({ hasText: "继续查看订单" }).click();
    await page.getByText("邻里有好戏", { exact: true }).waitFor({ state: "visible" });
    if ((await page.locator(".orders-page .lyx-card").count()) !== 2)
      throw new Error("游标续页未拼接");
    await page.locator(".lyx-tabs__item").filter({ hasText: "上线中" }).click();
    await page.getByText("暂无订单", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".lyx-tabs__item").filter({ hasText: "制作中" }).click();
    await page.getByText("烟火里的重逢", { exact: true }).waitFor({ state: "visible" });
    if ((await page.locator(".orders-page .lyx-card").count()) !== 1)
      throw new Error("切tab遗留旧游标结果");
  }
}
export async function publishRegression(page, scene) {
  if (scene !== "accounts-bind" && scene !== "accounts-rejected") return;
  if (scene === "accounts-rejected")
    await page
      .locator(".accounts-page .lyx-button")
      .filter({ hasText: "重新提交主页截图" })
      .click();
  const form = page.locator(".accounts-page__form");
  await form.waitFor({ state: "visible" });
  if (scene === "accounts-bind") {
    await form.locator("input").nth(0).fill("邻里咖啡新账号");
    await form.locator("input").nth(1).fill("coffee-new");
  }
  await form.locator(".lyx-upload-grid__add").click();
  const submit = page
    .locator(".accounts-page .lyx-sheet .lyx-button")
    .filter({ hasText: "提交核验" });
  await page.waitForFunction(() => {
    const button = globalThis.document.querySelector(
      ".accounts-page .lyx-sheet .lyx-button--primary",
    );
    return button && !button.classList.contains("lyx-button--disabled");
  });
  await submit.click();
  if (scene === "accounts-bind") {
    await page.getByText("网络暂时中断，请重试", { exact: true }).waitFor({ state: "visible" });
    await submit.click();
  }
  await page
    .getByText("待核验，通过后即可在订购时选择", { exact: true })
    .waitFor({ state: "visible" });
  const calls = await page.evaluate(() => globalThis.__LYX_PUBLISH_CALLS__);
  const writes = calls.filter((c) => c.method === "POST");
  if (
    scene === "accounts-bind" &&
    (writes.length !== 2 ||
      writes[0].key !== writes[1].key ||
      writes[1].data.accountUid !== "coffee-new")
  )
    throw new Error("绑定DTO/samekey不成立");
  if (
    scene === "accounts-rejected" &&
    (writes.length !== 1 ||
      !writes[0].path.endsWith("/submit") ||
      writes[0].data.accountName !== undefined ||
      writes[0].data.accountUid !== undefined)
  )
    throw new Error("重新核验不可改名称/账号ID");
  if (writes.some((c) => c.data.screenshotFileIds?.length !== 1))
    throw new Error("未发送已入库截图ID");
  if (calls.filter((c) => c.method === "GET").length < 2) throw new Error("绑定/重提后未刷新列表");
}
