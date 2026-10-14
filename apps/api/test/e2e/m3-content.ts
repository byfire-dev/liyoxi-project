// W3-19：内容演示与 E2E 共用。所有内容写入经过真实 HTTP；存储/codec 仅替换外部 IO。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { calendarDate, daysInMonth, formatLocalDate, parseLocalDate } from "@liyoxi/shared/time";
import type { M3Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { createM1Caller, type M1Headers, type M1Result } from "./runner-api.js";

export interface M3ContentReport {
  readonly dramaId: string;
  readonly title: string;
  readonly episodeCount: 2;
  /** 剧目行的新增/复用数；第二轮另比较真实相关业务 counts，不用此数字代替证据。 */
  readonly inserted: 0 | 1;
  readonly existing: 0 | 1;
  readonly batchId: string | null;
  readonly fileIds: readonly string[];
}
export interface M3ContentInput {
  readonly api: M1Api;
  readonly support: M3Support;
  readonly adminHeaders: M1Headers;
  readonly merchantHeaders?: M1Headers;
  readonly demoKey: string;
}
// 与 M1 同源的完整小 PNG，只作虚构演示海报/许可，不冒称真实版权证据。
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);
const episodeCount = 2 as const;

export async function verifyM3ContentMall(
  api: M1Api,
  headers: M1Headers,
  content: M3ContentReport,
) {
  const call = createM1Caller(api);
  const mall = await call("m.drama.list", headers, { query: { q: content.title, limit: 20 } });
  const visible = mall.items.find((item) => item.dramaId === content.dramaId);
  assert.ok(visible, "真实上架后商家商城必须可见本轮剧目");
  assert.equal(visible.totalEpisodes, episodeCount);
  assert.equal(typeof visible.listPricePoints, "number");
  return visible;
}

export async function ensureM3Content({
  api,
  support,
  adminHeaders,
  merchantHeaders,
  demoKey,
}: M3ContentInput): Promise<M3ContentReport> {
  assert.equal(api.support, support, "内容 HTTP 与媒体任务必须属于同一隔离支架");
  assert.notEqual(support.runtime.env.APP_ENV, "prod", "生产环境拒绝演示造数");
  assert.ok(demoKey.trim(), "内容演示必须有稳定且非空的意图标识");
  const title = `M3接口演示${createHash("sha256").update(demoKey).digest("hex").slice(0, 10)}`;
  const call = createM1Caller(api);
  const params = (dramaId: string) => ({ dramaId });

  async function published(dramaId: string) {
    const drama = await call("admin.drama.get", adminHeaders, { params: params(dramaId) });
    assert.equal(drama.status, "listed");
    assert.equal(drama.totalEpisodes, episodeCount);
    assert.ok(drama.posterFileId && drama.posterUrl, "已上架剧必须保有真实可读海报");
    const readiness = await call("admin.drama.mediaReadiness.get", adminHeaders, {
      params: params(dramaId),
    });
    assert.equal(readiness.masters.totalEpisodes, episodeCount);
    assert.equal(readiness.masters.withCurrentMaster, episodeCount);
    assert.deepEqual(readiness.masters.missingEpisodeNos, []);
    assert.equal(readiness.poster?.isBlocked, false);
    assert.equal(readiness.openUploadBatches.length, 0);
    const checks = await call("admin.drama.listingChecks.get", adminHeaders, {
      params: params(dramaId),
    });
    assert.ok(
      checks.isShelvable,
      `真实上架检查未通过：${checks.items
        .filter((item) => item.severity === "block" && !item.isOk)
        .map((item) => item.code)
        .join(",")}`,
    );
    assert.equal(checks.items.find((item) => item.code === "L10")?.isOk, true);
    const episodes = await call("admin.drama.dramaEpisode.list", adminHeaders, {
      params: params(dramaId),
      query: { pageSize: 2 },
    });
    assert.equal(episodes.total, episodeCount);
    assert.equal(episodes.items.length, episodeCount);
    for (const episode of episodes.items) {
      assert.equal(episode.masterState, "ready");
      assert.ok(episode.currentMaster, "原片必须通过真实批次 commit 激活");
      assert.equal(episode.currentMaster.file.status, "stored");
      assert.equal(episode.currentMaster.durationMs, support.productionVideo.durationMs);
    }
    return [
      ...new Set([
        drama.posterFileId,
        ...drama.copyright.proofFiles.map((file) => file.fileId),
        ...episodes.items.map((episode) => episode.currentMaster!.file.fileId),
      ]),
    ];
  }

  // 独立库内以稳定标题查真实 HTTP 事实；不在第二轮重放随机幂等键或另建原片版本。
  const existing = await call("admin.drama.list", adminHeaders, {
    query: { q: title, pageSize: 100 },
  });
  const matches = existing.items.filter((item) => item.title === title);
  assert.ok(matches.length <= 1, "同一演示意图存在重复剧目，拒绝随意选一部覆盖");
  if (matches[0]) {
    const dramaId = matches[0].dramaId;
    assert.equal(matches[0].status, "listed", "已有未完成内容不伪装幂等成功，保留现场排查");
    const before = await support.readFacts({ dramaIds: [dramaId] });
    const fileIds = await published(dramaId);
    const report: M3ContentReport = {
      dramaId,
      title,
      episodeCount,
      inserted: 0,
      existing: 1,
      batchId: null,
      fileIds,
    };
    if (merchantHeaders) await verifyM3ContentMall(api, merchantHeaders, report);
    const after = await support.readFacts({ dramaIds: [dramaId] });
    assert.deepEqual(after.counts, before.counts, "第二次内容演示不得新增任何相关业务行");
    return report;
  }

  // 题材编码由正式字典 API 分配；只复用真实启用项，不猜默认 genre 代码。
  const dictionaries = await call("admin.dictItem.list", adminHeaders, {
    query: { typeKey: "genre,industry", includeDisabled: true },
  });
  const genreName = "M3接口演示题材";
  let genre = dictionaries.items.find(
    (item) => item.typeKey === "genre" && item.name === genreName,
  );
  if (!genre)
    genre = await call("admin.dictItem.create", adminHeaders, {
      body: { typeKey: "genre", name: genreName, description: "仅隔离演示，非真实片库" },
    });
  assert.equal(genre.isEnabled, true, "已有停用演示题材不能被自动启用");
  const industry = dictionaries.items.find(
    (item) => item.typeKey === "industry" && item.code === support.profileDefaults.industryCode,
  );
  assert.ok(industry?.isEnabled, "缺少真实启用的商家行业前置，不自行绕过字典");

  async function imageFile(category: "poster" | "drama_license_doc") {
    const file = await call("admin.file.create", adminHeaders, {
      body: {
        category,
        fileName: `m3-${category}.png`,
        mime: "image/png",
        sizeBytes: String(png.length),
        clientToken: randomUUID(),
      },
    });
    assert.equal(file.mode, "post");
    assert.ok(file.post, "当前替身必须提供真实预签表单");
    assert.equal(
      support.providers.storage.upload(
        { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
        png,
      ),
      204,
    );
    await call("admin.file.complete", adminHeaders, { params: { fileId: file.fileId }, body: {} });
    await support.drainMedia({ fileIds: [file.fileId] });
    const stored = await call("admin.file.get", adminHeaders, { params: { fileId: file.fileId } });
    assert.equal(stored.status, "stored");
    assert.equal(stored.category, category);
    return file.fileId;
  }
  const posterId = await imageFile("poster"),
    licenseId = await imageFile("drama_license_doc");
  let drama: M1Result<"admin.drama.get"> = await call("admin.drama.create", adminHeaders, {
    body: { title },
  });
  const dramaId = drama.dramaId;
  drama = await call("admin.drama.basic.update", adminHeaders, {
    params: params(dramaId),
    body: {
      lockVersion: drama.lockVersion,
      posterFileId: posterId,
      totalEpisodes: episodeCount,
      episodeDurationSec: support.productionVideo.durationMs / 1000,
      genreCodes: [genre.code],
      synopsis: "虚构门店的两集故事，仅用于隔离接口演示。",
      dramaClass: "class_3",
      producerName: "M3隔离演示",
      isAiGenerated: false,
    },
  });
  await call("admin.drama.commercial.update", adminHeaders, {
    params: params(dramaId),
    body: {
      lockVersion: drama.lockVersion,
      heatTier: "B",
      industryCodes: [industry.code],
      allowedPlacements: ["opening", "ending"],
    },
  });
  await call("admin.drama.dramaPermit.create", adminHeaders, {
    params: params(dramaId),
    body: {
      platform: "all",
      permitKind: "program_no",
      permitNo: `M3-DEMO-${createHash("sha256").update(demoKey).digest("hex").slice(0, 12)}`,
      scanFileIds: [licenseId],
    },
  });
  drama = await call("admin.drama.get", adminHeaders, { params: params(dramaId) });
  const today = calendarDate(support.clock.now()),
    date = parseLocalDate(today);
  await call("admin.drama.copyright.replace", adminHeaders, {
    params: params(dramaId),
    body: {
      lockVersion: drama.copyright.lockVersion,
      source: "own",
      platforms: ["douyin", "wechat_channels"],
      territory: "中国大陆",
      hasNetworkRight: true,
      canSublicense: true,
      canEditEmbed: true,
      canAdapt: true,
      licenseStartDate: today,
      licenseEndDate: formatLocalDate(
        date.year + 2,
        date.month,
        Math.min(date.day, daysInMonth(date.year + 2, date.month)),
      ),
      proofFileIds: [licenseId],
    },
  });
  const missing = await call("admin.drama.listingChecks.get", adminHeaders, {
    params: params(dramaId),
  });
  assert.equal(
    missing.items.find((item) => item.code === "L10")?.isOk,
    false,
    "未上传母版不得伪报就绪",
  );
  assert.equal(missing.isShelvable, false);

  const video = support.productionVideo;
  let batch = await call("admin.uploadBatch.create", adminHeaders, {
    body: {
      purpose: "drama_master",
      targetId: dramaId,
      scope: "full",
      isContentChanged: false,
      note: "固定实测视频字节，经正式媒体任务生成元数据与检查",
      files: Array.from({ length: episodeCount }, (_, index) => ({
        clientToken: `m3-master-${index + 1}`,
        originalName: `第${index + 1}集.mp4`,
        sizeBytes: String(video.sizeBytes),
      })),
    },
  });
  const batchId = batch.uploadBatchId;
  assert.equal(batch.expectedCount, episodeCount);
  assert.deepEqual(batch.coverage.missingEpisodeNos, []);
  batch = await call("admin.uploadBatch.start", adminHeaders, {
    params: { uploadBatchId: batchId },
    body: {},
  });
  assert.equal(batch.items.length, episodeCount);
  const fileIds: string[] = [];
  for (const item of batch.items) {
    assert.ok(item.uploadKey, "HTTP 批次必须签发上传键");
    assert.ok(item.uploadKey.startsWith(batch.prefix), "上传键必须属于 HTTP 创建的当前批次");
    const post = await support.providers.storage.presignPost({
      bucket: "media",
      key: item.uploadKey,
      mime: "video/mp4",
      maxBytes: video.sizeBytes,
      expiresSec: 600,
    });
    assert.ok(post.ok, "本地对象替身必须签发当前批次表单");
    assert.equal(support.providers.storage.upload(post.value, video.bytes), 204);
    const completed = await call("admin.uploadBatchItem.complete", adminHeaders, {
      params: { uploadBatchItemId: item.uploadBatchItemId },
      body: {},
    });
    assert.equal(completed.fileStatus, "promoting");
    fileIds.push(item.fileId);
  }
  await support.drainMedia({ fileIds, batchIds: [batchId], dramaIds: [dramaId] });
  batch = await call("admin.uploadBatch.get", adminHeaders, { params: { uploadBatchId: batchId } });
  assert.equal(batch.state, "ready");
  assert.equal(batch.counts.checked, episodeCount);
  for (const item of batch.items) {
    assert.equal(item.check?.gate, "pass");
    assert.equal(item.durationMs, video.durationMs);
  }
  const committed: M1Result<"admin.uploadBatch.commit"> = await call(
    "admin.uploadBatch.commit",
    adminHeaders,
    { params: { uploadBatchId: batchId }, body: {} },
  );
  assert.equal(committed.batch.state, "committed");
  assert.equal(committed.masters.length, episodeCount);
  assert.ok(committed.masters.every((master) => master.revNo === 1));
  const readiness = await call("admin.drama.mediaReadiness.get", adminHeaders, {
    params: params(dramaId),
  });
  assert.equal(readiness.masters.withCurrentMaster, episodeCount);
  assert.deepEqual(readiness.masters.missingEpisodeNos, []);
  const checks = await call("admin.drama.listingChecks.get", adminHeaders, {
    params: params(dramaId),
  });
  assert.ok(
    checks.isShelvable,
    `批次完成后上架检查失败：${checks.items
      .filter((item) => item.severity === "block" && !item.isOk)
      .map((item) => item.code)
      .join(",")}`,
  );
  const shelved = await call("admin.drama.shelve", adminHeaders, {
    params: params(dramaId),
    body: {},
  });
  assert.equal(shelved.status, "listed");
  assert.ok(shelved.firstListedAt && shelved.copyright.currentRevisionId);
  const actualFiles = await published(dramaId);
  assert.deepEqual(new Set(actualFiles), new Set([posterId, licenseId, ...fileIds]));
  const activity = await call("admin.drama.activity.list", adminHeaders, {
    params: params(dramaId),
    query: { limit: 20 },
  });
  assert.ok(
    activity.items.some(
      (item) => item.transition?.toState === "listed" && item.transition.event === "drama.list",
    ),
    "HTTP 上架必须保有真实状态迁移与审计活动",
  );
  const report: M3ContentReport = {
    dramaId,
    title,
    episodeCount,
    inserted: 1,
    existing: 0,
    batchId,
    fileIds: actualFiles,
  };
  if (merchantHeaders) await verifyM3ContentMall(api, merchantHeaders, report);
  return report;
}
