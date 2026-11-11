import type { MediaJob } from "@liyoxi/db";
import { expect, it, vi } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { createFakeProviders } from "../testing/index.js";
import type { BoundMediaDeps } from "./context.js";
import { ZipInputSchema } from "./zip-types.js";
import { createZipHandler } from "./zip-handler.js";

// Input/controlled-fallback tests only; these do not claim a 999-episode production chain.
function input(count: number, text = "清单") {
  return {
    ownerType: "delivery_release",
    ownerId: uuidv7(),
    zipBundleId: uuidv7(),
    zipGen: 1,
    entityId: uuidv7(),
    storeId: uuidv7(),
    orderItemId: uuidv7(),
    keepUntil: "2030-01-01T00:00:00.000Z",
    zipFileName: "成片.zip",
    publishListText: text,
    items: Array.from({ length: count }, (_, index) => ({
      fileId: uuidv7(),
      key: `output/ep-${index}.mp4`,
      name: `第${index + 1}集.mp4`,
      size: "10",
      crc64: null,
      etag: "fixture-etag",
    })),
  };
}
it.each([101, 999])("接受正式内容集合的 %i 集完整输入，不加100集业务限制", (count) => {
  expect(ZipInputSchema.parse(input(count)).items).toHaveLength(count);
});
it.each([
  [999, "清单", "ZIP_PREVIEW_UNSUPPORTED"],
  [1, "a".repeat(200 * 1024 + 1), "ZIP_INPUT_UNSUPPORTED"],
] as const)("%i集输入的缓存能力边界在任何I/O前受控失败", async (count, text, code) => {
  const fake = createFakeProviders(),
    run = vi.fn(),
    head = vi.spyOn(fake.storage, "head"),
    pack = vi.spyOn(fake.media, "pack");
  const deps = {
    zipProvider: fake.media,
    storage: fake.storage,
    tx: { run },
  } as unknown as BoundMediaDeps;
  const handler = createZipHandler(deps),
    value = ZipInputSchema.parse(input(count, text));
  expect(
    await handler.execute(
      { input: value } as unknown as MediaJob,
      undefined,
      new AbortController().signal,
    ),
  ).toEqual({ state: "failed", failure: { code, retryable: false } });
  expect(run).not.toHaveBeenCalled();
  expect(head).not.toHaveBeenCalled();
  expect(pack).not.toHaveBeenCalled();
});
