import { beforeAll, expect, it } from "vitest";
import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import { createEvents } from "../events/index.js";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia } from "./index.js";
import type { DeliveryDownloadSignInput } from "./index.js";

const db = useSeededDatabase("services");
let prisma: Awaited<ReturnType<typeof db.prisma>>;
beforeAll(async () => {
  prisma = await db.prisma();
}, 120000);

function setup() {
  const clock = createClock(new Date("2026-01-05T04:10:00Z")),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api" }),
    fake = createFakeProviders({ clock }),
    make = createFactories({ db: prisma, clock }),
    media = createMedia({
      tx,
      clock,
      assembly,
      events: createEvents({ tx, clock, assembly }),
      storage: fake.storage,
    });
  const file = async (category: UploadCategory, ext = "mp4") => {
    const mime = ext === "jpg" ? "image/jpeg" : ext === "pdf" ? "application/pdf" : "video/mp4";
    const row = await make.fileObject({
      category,
      bucket: UPLOAD_CATEGORIES[category].bucket,
      ext,
      originalName: `上传原名.${ext}`,
      declaredMime: mime,
      mime,
    });
    fake.storage.put(
      { bucket: UPLOAD_CATEGORIES[category].bucket, key: row.objectKey },
      new Uint8Array([1, 2, 3]),
      row.mime!,
    );
    return row;
  };
  return { clock, fake, make, media, file };
}
const snapshot = () =>
  Promise.all([
    prisma.fileObject.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.count(),
    prisma.outboxEvent.count(),
    prisma.statusTransition.count(),
    prisma.fileRef.count(),
    prisma.productionRecord.count(),
    prisma.mediaJob.count(),
  ]);

it.each([
  ["sample_video", "小城故事_样片_第2版.mp4"],
  ["sample_wm", "小城故事_样片_第3版.mp4"],
  ["final_episode", "小城故事_第2集.mp4"],
  ["sample_video", "小城故事_第1集.mp4"],
] as const)("%s 交付附件 %s 实签900秒，业务名生效且零数据库写", async (category, fileName) => {
  const h = setup(),
    file = await h.file(category),
    before = await snapshot(),
    input: DeliveryDownloadSignInput = { fileId: file.id, fileName },
    signed = await h.media.signDeliveryDownload(input);
  expect(h.fake.storage.callsOf("presignGet").map((c) => c.input)).toEqual([
    {
      bucket: UPLOAD_CATEGORIES[category].bucket,
      key: file.objectKey,
      expiresSec: 900,
      disposition: "attachment",
      downloadName: fileName,
    },
  ]);
  expect(signed.expiresAt).toBe("2026-01-05T04:25:00.000Z");
  expect(h.fake.storage.fetch(signed.url)).toMatchObject({
    status: 200,
    contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  h.clock.advance(900_001);
  expect(h.fake.storage.fetch(signed.url)).toEqual({ status: 403 });
  expect(await snapshot()).toEqual(before);
});

it("缺失、未入库与被屏蔽文件拒绝，零签名、零数据库写", async () => {
  const h = setup(),
    pending = await h.make.fileObject({ status: "pending", storedAt: null }),
    blocked = await h.make.fileObject({ moderationState: "block" }),
    before = await snapshot();
  for (const fileId of [uuidv7(), pending.id, blocked.id])
    await expect(
      h.media.signDeliveryDownload({ fileId, fileName: "小城故事_样片_第1版.mp4" }),
    ).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
  expect(h.fake.storage.callsOf("presignGet")).toEqual([]);
  expect(await snapshot()).toEqual(before);
});

it("同文件同时间的附件缓存按业务名隔离，相同名仍可复用", async () => {
  const h = setup(),
    file = await h.file("poster", "jpg"),
    first = await h.media.signDeliveryDownload({ fileId: file.id, fileName: "剧甲.jpg" }),
    second = await h.media.signDeliveryDownload({ fileId: file.id, fileName: "剧乙:封面.jpg" });
  expect(second.url).not.toBe(first.url);
  expect(h.fake.storage.fetch(first.url)).toMatchObject({
    contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("剧甲.jpg")}`,
  });
  expect(h.fake.storage.fetch(second.url)).toMatchObject({
    contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("剧乙:封面.jpg")}`,
  });
  expect(await h.media.signDeliveryDownload({ fileId: file.id, fileName: "剧甲.jpg" })).toEqual(
    first,
  );
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(2);
});

it("原读口播放、员工与商家TTL和原附件名保持，图片窗口仍稳定", async () => {
  const h = setup(),
    sample = await h.file("sample_video"),
    final = await h.file("final_episode"),
    secure = await h.file("drama_license_doc", "pdf"),
    image = await h.file("poster", "jpg");
  await h.media.signRead({ fileId: sample.id });
  await h.media.signRead({ fileId: final.id, audience: "staff" });
  await h.media.signRead({ fileId: final.id, audience: "merchant" });
  await h.media.signRead({ fileId: secure.id });
  const attached = await h.media.signRead({ fileId: sample.id, disposition: "attachment" });
  expect(h.fake.storage.callsOf("presignGet").map((c) => c.input)).toMatchObject([
    { expiresSec: 3600, disposition: "inline" },
    { expiresSec: 1800, disposition: "inline" },
    { expiresSec: 900, disposition: "inline" },
    { expiresSec: 300, disposition: "inline" },
    { expiresSec: 3600, disposition: "attachment", downloadName: "上传原名.mp4" },
  ]);
  expect(h.fake.storage.fetch(attached.url)).toMatchObject({
    contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("上传原名.mp4")}`,
  });
  const a = await h.media.signRead({ fileId: image.id });
  h.clock.advance(1000);
  expect(await h.media.signRead({ fileId: image.id })).toEqual(a);
});
