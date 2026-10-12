import { expect } from "@playwright/test";

/** 平台为离线边界，表单、持久任务与公共 POST 编排均真实执行。 */
export async function assetUploadRegression(page, scene) {
  const root = () => page.locator(".taro_page_stationed:not(.taro_page_shade) .asset-upload");
  const button = (text) =>
    root()
      .locator(".lyx-button, .lyx-text-button")
      .filter({ hasText: new RegExp(`^${text}$`) });
  const events = () => page.evaluate(() => globalThis.__LYX_ASSET_UPLOAD_CONTROL__?.events ?? []);
  const creates = async () => (await events()).filter((event) => event.action === "create");
  const release = () => page.evaluate(() => globalThis.__LYX_ASSET_UPLOAD_CONTROL__.release());
  if (scene.endsWith("loading")) {
    await expect(root().locator(".lyx-skeleton")).toBeVisible();
    expect(await creates()).toHaveLength(0);
    return;
  }
  await expect(
    page.locator(".taro_page_stationed:not(.taro_page_shade) .asset-upload#asset-upload-ready"),
  ).toBeVisible();
  if (scene.endsWith("clerk-gated"))
    await expect(root().locator(".lyx-note").first()).toContainText("店员上传");
  if (scene.endsWith("options-error")) {
    await expect(root().locator(".lyx-empty")).toContainText("需求暂时不可用");
    await button("重新加载").click();
    await expect(root().locator(".asset-upload__tags .lyx-chip")).toHaveCount(1);
    expect((await events()).filter((event) => event.action === "demands")).toHaveLength(2);
    return;
  }
  if (
    scene.endsWith("resume-reselect") ||
    scene.endsWith("resume-mismatch") ||
    scene.endsWith("recovery-blocked")
  ) {
    await expect(root().locator(".asset-upload__task")).toHaveCount(1);
    expect((await events()).filter((event) => event.action === "register")).toHaveLength(0);
    if (scene.endsWith("recovery-blocked")) {
      await button("确认取消未入库文件").click();
      await expect(root().locator(".asset-upload__task")).toContainText("恢复已阻止");
      expect((await events()).filter((event) => event.action === "cancel")).toHaveLength(1);
      expect((await events()).filter((event) => event.action === "post")).toHaveLength(0);
      return;
    }
    await button("重选同一文件").click();
    if (scene.endsWith("resume-mismatch")) {
      await expect(root().locator(".asset-upload__task")).toContainText("重选文件与原上传不一致");
      expect((await events()).filter((event) => event.action === "register")).toHaveLength(0);
      return;
    }
    await expect
      .poll(async () => (await events()).filter((event) => event.action === "post").length)
      .toBe(1);
    expect(await creates()).toHaveLength(0);
    await release();
    await expect(root().locator(".asset-upload__task")).toContainText("素材已提交");
    return;
  }
  const type =
    ["video", "recording", "audio", "document", "text"].find((name) => scene.endsWith(name)) ??
    "image";
  const labels = {
    image: "图片",
    video: "视频",
    recording: "录音",
    audio: "音频",
    document: "文档",
    text: "文字",
  };
  if (type !== "image")
    await root().locator(".lyx-tabs__item").filter({ hasText: labels[type] }).click();
  await root().locator(".asset-upload__tags .lyx-chip").click();
  await button("更多素材需求").click();
  await expect(root().locator(".asset-upload__demands .lyx-chip")).toHaveCount(3);
  await root().locator(".asset-upload__demands .lyx-chip").filter({ hasText: "服务细节" }).click();
  if (type === "text")
    await root().locator(".asset-upload__text textarea").fill("每日现磨咖啡，欢迎来店坐坐。");
  else {
    if (type === "recording") {
      await button("开始录音").click();
      await button("停止录音").click();
      await expect(root().locator(".asset-upload__file")).toContainText("42秒");
      await button("试听").click();
      await button("停止试听").click();
    } else await button(`选择${labels[type]}`).click();
    await root().locator(".asset-upload__note textarea").fill("门店实拍");
  }
  await button("提交素材").click();
  if (type !== "text") {
    await expect
      .poll(async () => (await events()).filter((event) => event.action === "post").length)
      .toBe(1);
    expect(await creates()).toHaveLength(0);
    const registration = (await events()).find((event) => event.action === "register");
    expect(registration.data.category).toBe("store_asset");
    expect(registration.data.files).toHaveLength(1);
    if (scene.endsWith("cancel-error")) {
      await button("确认取消未入库文件").click();
      await expect(root().locator(".asset-upload__task")).toContainText("取消未确认");
      const first = (await events()).filter((event) => event.action === "cancel");
      await button("重试确认取消").click();
      await expect(root().locator(".asset-upload__task")).toContainText("已取消");
      const cancelled = (await events()).filter((event) => event.action === "cancel");
      expect(cancelled).toHaveLength(2);
      expect(cancelled[1]).toEqual(first[0]);
      expect(await creates()).toHaveLength(0);
      return;
    }
    if (scene.endsWith("scope-late")) {
      await page.evaluate(() => {
        const old = globalThis.__LYX_ASSET_UPLOAD_CONTROL__;
        old.changeScope();
        old.release();
      });
      await expect(root().locator(".asset-upload__task")).toContainText("需要重选文件");
      expect(await creates()).toHaveLength(0);
      return;
    }
    await release();
  }
  if (scene.endsWith("partial")) {
    await expect(root().locator(".asset-upload__task")).toContainText("尚有文件未入库");
    expect(await creates()).toHaveLength(0);
    const completed = (await events()).filter((event) => event.action === "complete");
    expect(completed).toHaveLength(1);
    await button("重试未完成任务").click();
  }
  if (scene.endsWith("create-unknown")) {
    await expect(root().locator(".asset-upload__task")).toContainText("提交待确认");
    const original = (await creates())[0];
    await button("用原意图确认提交").click();
    await expect(root().locator(".asset-upload__task")).toContainText("素材已提交");
    const replay = await creates();
    expect(replay).toHaveLength(2);
    expect(replay[1]).toEqual(original);
  } else await expect(root().locator(".asset-upload__task")).toContainText("素材已提交");
  const calls = await creates(),
    body = calls.at(-1).data;
  expect(body.type).toBe(type);
  expect(body.contentTagCodes).toEqual(["store"]);
  expect(body.assetDemandId).toBe("019aa000-0000-7000-8000-000000000010");
  if (type === "text") {
    expect(body.textBody).toBe("每日现磨咖啡，欢迎来店坐坐。");
    expect(body).not.toHaveProperty("fileIds");
    expect((await events()).filter((event) => event.action === "register")).toHaveLength(0);
  } else {
    const completed = (await events()).filter((event) => event.action === "complete");
    expect(body.fileIds).toEqual(completed.map((event) => event.fileId));
    expect(body.note).toBe("门店实拍");
    expect((await events()).findIndex((event) => event.action === "create")).toBeGreaterThan(
      (await events()).findLastIndex((event) => event.action === "complete"),
    );
  }
  await expect(button("查看素材详情")).toBeVisible();
}
