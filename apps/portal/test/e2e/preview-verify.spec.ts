import { expect, test, type Page } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { ERRORS } from "@liyoxi/contract/errors";
import {
  CaseClosed,
  CaseReady,
  HttpResult,
  PreviewFacts,
  ReadResult,
  ReadWindow,
  control,
  type CaseId,
} from "./control-client";
import { approve, caseId, data, shot, ticket } from "./live-helpers";

// One owned producer sequence: v1→v2, issued→correction→void, then grant expiry last.
// Every test still receives Playwright's fresh browser context; no Cookie or state is injected.
test.describe.configure({ mode: "serial" });
const facts = (id: CaseId) => control(id, { op: "preview.facts", input: {} }, PreviewFacts);
type PreviewAction =
  | "push-ad-version"
  | "queue-license-correction"
  | "complete-license-correction"
  | "void-license"
  | "expire-media-grants"
  | "ad-channel-unavailable"
  | "ad-channel-available";
const action = (id: CaseId, value: PreviewAction) =>
  control(id, { op: "preview.action", input: { action: value } }, PreviewFacts);
const traffic = (page: Page) => page.evaluate(() => window.__LYX_PORTAL_LIVE__.traffic());
async function settled(page: Page) {
  await expect.poll(async () => (await traffic(page)).pending).toBe(0);
}
async function navigate(page: Page, target: string) {
  await page.evaluate((value) => window.__LYX_PORTAL_LIVE__.navigate(value), target);
}
async function zeroWrites(page: Page, id: CaseId, read: () => Promise<void>) {
  await settled(page);
  const readWindow = await control(id, { op: "facts.beginRead", input: {} }, ReadWindow);
  await read();
  await settled(page);
  expect(
    await control(
      id,
      { op: "facts.endRead", input: { windowId: readWindow.windowId } },
      ReadResult,
    ),
  ).toEqual({ unchanged: true, changedTables: [] });
}
async function ad(page: Page, id: string, version: number) {
  await navigate(page, `/preview/ad/${id}`);
  await expect(page.getByText(`当前已推送第 ${version} 版`, { exact: true })).toBeVisible();
  await settled(page);
}
async function play(page: Page, version: number) {
  await page.getByRole("button", { name: `播放第 ${version} 版`, exact: true }).click();
  await decoded(page);
}
async function decoded(page: Page) {
  const video = page.getByLabel("广告视频");
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return {
          width: media.videoWidth,
          height: media.videoHeight,
          duration: Number.isFinite(media.duration) ? Math.round(media.duration * 1000) : 0,
        };
      }),
    )
    .toEqual({ width: 1080, height: 1920, duration: 3000 });
  await video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.1);
  await video.evaluate((element) => (element as HTMLVideoElement).pause());
  await settled(page);
}
async function query(page: Page, code: string, rev: string | null, text: string) {
  const search = new URLSearchParams({ code });
  if (rev !== null) search.set("rev", rev);
  const before = (await traffic(page)).items.filter((item) => item.kind === "verification").length;
  await navigate(page, `/v?${search}`);
  await expect
    .poll(
      async () => (await traffic(page)).items.filter((item) => item.kind === "verification").length,
    )
    .toBeGreaterThan(before);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await settled(page);
  const requests = (await traffic(page)).items
    .filter((item) => item.kind === "verification")
    .slice(before);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((item) => item.method === "GET" && item.revision === rev)).toBe(true);
  expect(await page.locator("iframe, embed, object, a[href*='.pdf']").count()).toBe(0);
}
function anonymousRequests(page: Page) {
  let cookieSeen = false;
  const pending: Promise<void>[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/"))
      pending.push(
        request.headerValue("cookie").then((value) => {
          cookieSeen ||= Boolean(value);
        }),
      );
  });
  return async () => {
    await Promise.all(pending);
    expect(cookieSeen).toBe(false);
    expect((await page.context().cookies()).length).toBe(0);
    const log = await traffic(page);
    expect(log.items.some((item) => item.kind === "session" || item.kind === "ticket")).toBe(false);
    expect(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.publicPrivacy().safe)).toBe(true);
  };
}

let expiryDeadline: number | undefined;
// This hook has no page fixture, so the existing page setup and all later waiting count
// against the same original test budget. No timeout is changed.
test.beforeEach(() => {
  const info = test.info();
  if (info.title === "preview-expired-media") expiryDeadline = performance.now() + info.timeout;
});
async function ticketAfterCooldown(page: Page) {
  const issue = async () => {
    // Register the observation before the explicit browser action; never parse a successful
    // create response here, because its private pollSecret must remain in the browser.
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/api/v1/portal/portal-tickets" &&
        value.request().method() === "POST",
      { timeout: 10_000 },
    );
    const [received, reply] = await Promise.all([
      response,
      page.evaluate(() => window.__LYX_PORTAL_LIVE__.beginTicket()),
    ]);
    return { received, reply };
  };
  const first = await issue();
  if (first.received.status() !== 429) {
    expect(first.received.status()).toBe(200);
    return data(first.reply);
  }
  expect(first.reply).toEqual({ ok: false, error: "RATE_LIMITED", httpStatus: 429 });
  let limited: boolean;
  try {
    const value: unknown = await first.received.json();
    limited =
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "error" in value &&
      value.code === ERRORS.RATE_LIMITED.code &&
      value.error === "RATE_LIMITED";
  } catch {
    throw new Error("COOLDOWN_RESPONSE_INVALID");
  }
  expect(limited).toBe(true);
  const header = await first.received.headerValue("retry-after");
  const seconds = header !== null && /^[1-9]\d?$/.test(header) ? Number(header) : 0;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
    throw new Error("COOLDOWN_DELAY_INVALID");
  const waitMs = seconds * 1000;
  // Reserve the original 10-second observation allowance for the remaining real flow.
  if (expiryDeadline === undefined || waitMs + 10_000 >= expiryDeadline - performance.now())
    throw new Error("COOLDOWN_EXCEEDS_REMAINING_CASE_BUDGET");
  await delay(waitMs);
  // One deliberate new operation after the actual server cooldown, never a case retry.
  const second = await issue();
  expect(second.received.status()).toBe(200);
  return data(second.reply);
}

test.beforeEach(async ({ page }, info) => {
  await control(caseId(info.title), { op: "case.begin", input: {} }, CaseReady);
  await page.goto("/__portal-live/session");
  await expect(page.getByTestId("portal-live-ready")).toBeVisible();
  expect((await page.context().cookies()).length).toBe(0);
});
test.afterEach(async ({ page }, info) => {
  let disposalFailed = false;
  try {
    await page.evaluate(() => window.__LYX_PORTAL_LIVE__.dispose());
  } catch {
    disposalFailed = true;
  }
  const closed = await control(caseId(info.title), { op: "case.end", input: {} }, CaseClosed);
  if (info.status === "passed") {
    expect(disposalFailed).toBe(false);
    expect(closed.abandonedReadWindow).toBe(false);
  }
});

test("preview-ad-playback", async ({ page }) => {
  const id = "preview-ad-playback";
  const prepared = await control(id, { op: "preview.prepare", input: {} }, PreviewFacts);
  await approve(page, id, await ticket(page));
  await zeroWrites(page, id, async () => {
    await ad(page, prepared.ad.adId, 1);
    await expect(page.locator("video")).toHaveCount(0);
    expect((await traffic(page)).items.filter((item) => item.kind === "ad-playback")).toEqual([]);
    expect((await facts(id)).playbackAuditCount).toBe(0);
  });
  await shot(page, "ad-initial");
  await play(page, 1);
  expect(
    (await traffic(page)).items
      .filter((item) => item.kind === "ad-playback")
      .map((item) => item.status),
  ).toEqual([200]);
  expect((await facts(id)).playbackAuditCount).toBe(1);
  await shot(page, "ad-playing");
});

test("preview-ad-stale-channel", async ({ page }) => {
  const id = "preview-ad-stale-channel",
    initial = await facts(id);
  await approve(page, id, await ticket(page));
  await ad(page, initial.ad.adId, 1);
  const pushed = await action(id, "push-ad-version");
  expect(pushed.ad.versionNo).toBe(2);
  await page.getByRole("button", { name: "播放第 1 版", exact: true }).click();
  await expect(
    page.getByText("广告已有新版本，请重新查看后点击播放。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("当前已推送第 2 版", { exact: true })).toBeVisible();
  await settled(page);
  expect(
    (await traffic(page)).items
      .filter((item) => item.kind === "ad-playback")
      .map((item) => item.status),
  ).toEqual([409]);
  expect((await facts(id)).playbackAuditCount).toBe(initial.playbackAuditCount);
  await expect(page.locator("video")).toHaveCount(0);
  await shot(page, "ad-version-changed");
  await action(id, "ad-channel-unavailable");
  await page.getByRole("button", { name: "播放第 2 版", exact: true }).click();
  await expect(
    page.getByText("这一版广告没有提供这种查看方式，请换一种", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "刷新广告详情", exact: true }).click();
  await expect(
    page.getByText("当前暂不能在电脑预览，请回到小程序查看说明或联系服务经理。", { exact: true }),
  ).toBeVisible();
  await settled(page);
  expect(
    (await traffic(page)).items
      .filter((item) => item.kind === "ad-playback")
      .map((item) => item.status),
  ).toEqual([409, 409]);
  expect((await facts(id)).playbackAuditCount).toBe(initial.playbackAuditCount);
  await expect(page.locator("video")).toHaveCount(0);
  await shot(page, "ad-channel-unavailable");
  await action(id, "ad-channel-available");
  await page.getByRole("button", { name: "刷新广告详情", exact: true }).click();
  await expect(page.getByRole("button", { name: "播放第 2 版", exact: true })).toBeVisible();
  expect((await traffic(page)).items.filter((item) => item.kind === "ad-playback")).toHaveLength(2);
});

test("preview-cross-store-q9", async ({ page }) => {
  const id = "preview-cross-store-q9",
    prepared = await facts(id);
  await approve(page, id, await ticket(page), "otherOwner");
  await zeroWrites(page, id, async () => {
    const before = (await traffic(page)).items.length;
    await navigate(page, `/preview/sample/${prepared.ad.adId}`);
    await expect(
      page.getByRole("heading", { name: "样片请在小程序查看并确认", exact: true }),
    ).toBeVisible();
    await settled(page);
    expect(
      (await traffic(page)).items
        .slice(before)
        .every((item) => item.kind === "session" && item.method === "GET"),
    ).toBe(true);
    await expect(page.locator("video")).toHaveCount(0);
    await shot(page, "sample-q9");
    await navigate(page, `/preview/ad/${prepared.ad.adId}`);
    await expect(page.getByText("暂时无法查看此广告", { exact: true })).toBeVisible();
    await settled(page);
    const reads = (await traffic(page)).items.filter((item) => item.kind === "ad-detail");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((item) => item.status === 404)).toBe(true);
    await expect(page.locator("video")).toHaveCount(0);
    expect((await traffic(page)).items.some((item) => item.kind === "ad-playback")).toBe(false);
  });
  await shot(page, "ad-cross-store");
});

test("preview-revoke-media", async ({ page }) => {
  const id = "preview-revoke-media",
    prepared = await facts(id);
  const state = await approve(page, id, await ticket(page));
  await ad(page, prepared.ad.adId, 2);
  await play(page, 2);
  const media = await page.getByLabel("广告视频").elementHandle();
  expect(media).not.toBeNull();
  const revoked = await control(
    id,
    { op: "session.revoke", input: { actor: "owner", portalSessionId: state.portalSessionId! } },
    HttpResult,
  );
  expect(revoked).toMatchObject({ httpStatus: 200, error: null });
  expect(data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.loadSession()))).toMatchObject({
    authenticated: false,
    httpStatus: 401,
    reason: "revoked",
  });
  await expect(page.getByText("门店老板已撤销这台电脑的授权", { exact: true })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  expect(
    await media!.evaluate((element) => ({
      paused: (element as HTMLVideoElement).paused,
      noSource: !element.hasAttribute("src"),
      connected: element.isConnected,
    })),
  ).toEqual({ paused: true, noSource: true, connected: false });
  expect((await traffic(page)).items.filter((item) => item.kind === "ad-playback")).toHaveLength(1);
  await shot(page, "ad-revoked");
});

test("verify-revisions", async ({ page }) => {
  const id = "verify-revisions",
    prepared = await facts(id),
    checkAnonymous = anonymousRequests(page);
  const code = prepared.license.verifyCode;
  await zeroWrites(page, id, async () => {
    await query(page, code, "001", "核对的是当前第 1 版");
    await expect(page.getByText("授权状态：生效中", { exact: true })).toBeVisible();
    expect(await page.locator("code").allTextContents()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    );
    await shot(page, "verify-current", true);
  });
  const queued = await action(id, "queue-license-correction");
  expect(queued.license).toMatchObject({ revNo: 1, pendingRevNo: 2 });
  await zeroWrites(page, id, async () => {
    await query(page, code, "2", "未查到第 2 版的已出件记录，以下为当前已出件版本");
    await expect(
      page.getByText("新版本生成中，以下仍为当前已出件版本。", { exact: true }),
    ).toBeVisible();
    await shot(page, "verify-pending", true);
  });
  const completed = await action(id, "complete-license-correction");
  expect(completed.license).toMatchObject({ revNo: 2, pendingRevNo: null });
  await zeroWrites(page, id, async () => {
    await query(page, code, "1", "已有更新版本：当前第 2 版，本次为第 1 版");
    await expect(page.getByRole("region", { name: "第 1 版证明", exact: true })).toBeAttached();
    await shot(page, "verify-outdated", true);
    await query(page, code, "99", "未查到第 99 版的已出件记录，以下为当前已出件版本");
    await shot(page, "verify-revision-missing", true);
    for (const raw of [null, "", "bad", "-1", "1.5", "0"])
      await query(page, code, raw, "未指定核对版次，请对照内容指纹");
    await query(page, code, "002", "核对的是当前第 2 版");
  });
  await checkAnonymous();
});

test("verify-lifecycle-reporting", async ({ page }) => {
  const id = "verify-lifecycle-reporting",
    prepared = await facts(id),
    checkAnonymous = anonymousRequests(page);
  await zeroWrites(page, id, async () => {
    await query(page, prepared.license.expiredVerifyCode, "1", "授权状态：已失效");
    await shot(page, "verify-expired", true);
  });
  const voided = await action(id, "void-license");
  expect(voided.license.displayStatus).toBe("voided");
  await zeroWrites(page, id, async () => {
    await query(page, prepared.license.verifyCode, "2", "授权状态：已作废");
    await shot(page, "verify-voided", true);
    for (const code of [prepared.license.unissuedVerifyCode, "public-unknown-verification-code"]) {
      await query(page, code, null, "未查到这份授权书，请核对二维码或验真码");
      const last = (await traffic(page)).items
        .filter((item) => item.kind === "verification")
        .at(-1);
      expect(last?.status).toBe(404);
      await expect(page.getByText("当前已出件版授权内容", { exact: true })).toHaveCount(0);
    }
    await shot(page, "verify-invalid", true);
  });
  // The production reporter receives a fake public DSN and sends to the real same-origin API.
  // This 202 is a transport acceptance check, never evidence of external Sentry delivery.
  await page.evaluate(() => window.__LYX_PORTAL_LIVE__.reportProbe());
  await expect
    .poll(async () =>
      (await traffic(page)).items
        .filter((item) => item.kind === "report")
        .map((item) => item.status),
    )
    .toEqual([202]);
  expect(await page.getByText("PUBLIC-PORTAL-ERROR-SENTINEL", { exact: true }).count()).toBe(0);
  await checkAnonymous();
});

test("preview-expired-media", async ({ page }) => {
  const id = "preview-expired-media",
    prepared = await facts(id);
  await approve(page, id, await ticketAfterCooldown(page));
  await page.clock.install();
  await ad(page, prepared.ad.adId, 2);
  await play(page, 2);
  const before = (await facts(id)).playbackAuditCount;
  await action(id, "expire-media-grants");
  // Capability remains entirely in the browser; return only the real HTTP status.
  const expired = await page.getByLabel("广告视频").evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    const response = await fetch(media.currentSrc, {
      cache: "no-store",
      headers: { Range: "bytes=0-1" },
    });
    const status = response.status;
    await response.body?.cancel();
    return status;
  });
  expect(expired).toBe(410);
  // Advance the browser by the same fixed fixture interval; exercise the real expiry timer.
  // Reloading an already buffered short video does not guarantee a new media network request.
  await page.clock.fastForward(3_601_000);
  await expect(page.getByText("播放地址已过期，请重新获取后播放。", { exact: true })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  expect((await facts(id)).playbackAuditCount).toBe(before);
  expect((await traffic(page)).items.filter((item) => item.kind === "ad-playback")).toHaveLength(1);
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/api/v1/portal/sessions/current", { cache: "no-store" });
      const status = response.status;
      await response.body?.cancel();
      return status;
    }),
  ).toBe(200);
  await shot(page, "ad-expired");
  await page.getByRole("button", { name: "重新获取播放地址", exact: true }).click();
  await decoded(page);
  expect((await facts(id)).playbackAuditCount).toBe(before + 1);
  expect(
    (await traffic(page)).items
      .filter((item) => item.kind === "ad-playback")
      .map((item) => item.status),
  ).toEqual([200, 200]);
  await shot(page, "ad-renewed");
});
