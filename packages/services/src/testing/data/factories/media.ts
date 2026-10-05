// 文件：file_object（06 分组）。只插登记行，不往对象存储里放东西。
import { defined } from "./context.js";
import type { FactoryContext } from "./context.js";
import type { TableFactories } from "./types.js";

export function mediaFactories(ctx: FactoryContext): Pick<TableFactories, "fileObject"> {
  return {
    /** 缺省：平台范围、系统上传、已入库的一张海报图 */
    async fileObject(input = {}) {
      const id = input.id ?? ctx.id();
      const now = ctx.now();
      const ext = input.ext ?? "jpg";
      return ctx.db.fileObject.create({
        data: {
          bucket: "pub",
          objectKey: `test/${id}.${ext}`,
          category: "poster",
          scopeType: "platform",
          uploadActorType: "system",
          status: "stored",
          declaredSize: 1024,
          declaredMime: "image/jpeg",
          ext,
          sizeBytes: 1024,
          mime: "image/jpeg",
          storedAt: now,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
        },
      });
    },
  };
}
