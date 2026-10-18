import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { MediaActor } from "../../media/index.js";
import { sampleStaffContext } from "../approval.js";
import type { FakeStorage } from "../providers/index.js";
import type { AdminLiveFixture } from "./context.js";

/** 只读页前置通过真实媒体公口产生；外部字节只进入隔离 FakeStorage，不代表云文件可达。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  if (runtime.env.APP_ENV !== "test" || runtime.providers.storage.status !== "fake")
    throw new Error("W318素材前置只接受隔离测试和内存存储");
  const storage = runtime.providers.storage as FakeStorage;
  if (typeof storage.put !== "function") throw new Error("W318需要正式测试存储替身");
  const staff = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
  );
  const actor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await runtime.tx.run((tx) => sampleStaffContext(tx, staff.id)),
  };
  const merchant = await make.merchant({ verified: true });
  const other = await make.merchant({ verified: true });
  const textBody = "W318虚构咖啡门店手作说明；机器没有结论时须人工整理。";
  const text = await runtime.media.assets.create(actor, {
    storeId: merchant.store.id,
    type: "text",
    textBody,
  });
  const second = await runtime.media.assets.create(actor, {
    storeId: merchant.store.id,
    type: "text",
    textBody: "W318虚构门店的第二份文字资料。",
  });
  const foreign = await runtime.media.assets.create(actor, {
    storeId: other.store.id,
    type: "text",
    textBody: "W318其他门店的资料不得混入当前门店。",
  });
  const body = new TextEncoder().encode("W318 fictional plain text document.\n");
  const registered = (
    await runtime.media.register(actor, {
      category: "store_asset",
      storeId: merchant.store.id,
      onBehalfStore: true,
      files: [
        {
          fileName: "W318-fictional.txt",
          sizeBytes: String(body.byteLength),
          clientToken: uuidv7(),
        },
      ],
    })
  ).items[0]!;
  const file = await runtime.tx.run((tx) =>
    tx.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } }),
  );
  storage.put({ bucket: "asset", key: registered.key }, body, "text/plain");
  await runtime.media.complete(actor, file.id);
  const job = await runtime.tx.run((tx) =>
    tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${file.id}` } }),
  );
  await runtime.media.promote({ jobId: job.id });
  const document = await runtime.media.assets.create(actor, {
    storeId: merchant.store.id,
    type: "document",
    fileIds: [file.id],
    note: "W318虚构文档；只核服务端文件事实与现签，不声明真实云下载。",
  });
  return {
    storeId: merchant.store.id,
    storeName: merchant.store.name,
    otherStoreId: other.store.id,
    text: { storeAssetId: text.storeAssetId, textBody },
    secondId: second.storeAssetId,
    foreignId: foreign.storeAssetId,
    document: {
      storeAssetId: document.storeAssetId,
      fileId: file.id,
      originalName: file.originalName,
    },
  };
};
export default fixture;
