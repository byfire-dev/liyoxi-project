import { AdminStoreAssetDetailSchema } from "@liyoxi/contract";
import { createIdentityContext } from "../../kernel/index.js";
import { sampleStaffContext } from "../approval.js";
import type { AdminLiveFixture } from "./context.js";

/** 虚构文字经正式洞察任务收尾；不直接改 processing/review/authorization 事实。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  if (runtime.env.APP_ENV !== "test" || runtime.providers.storage.status !== "fake")
    throw new Error("素材写页前置只接受隔离测试替身");
  const name = decodeURIComponent(new URL(runtime.env.DATABASE_URL).pathname.slice(1));
  const runId = /^lyx_test_admin_live_([a-f0-9]{16})$/.exec(name)?.[1];
  if (!runId) throw new Error("素材写页前置只接受本轮 admin_live 测试库");
  const startedAt = runtime.clock.now().toISOString();
  const staff = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
  );
  const actor = {
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await runtime.tx.run((tx) => sampleStaffContext(tx, staff.id)),
  };
  const merchant = await make.merchant({ verified: true });
  for (const dimension of ["content", "usage", "timeliness"] as const)
    await runtime.configAdmin.createDictItem(actor, {
      typeKey: "asset_tag",
      name: `W318虚构${dimension}`,
      ext: { dimension },
    });
  const tags = await runtime.tx.run((tx) =>
    tx.dictItem.findMany({
      where: { dictTypeKey: "asset_tag", name: { startsWith: "W318虚构" }, isEnabled: true },
      select: { code: true, name: true, ext: true },
    }),
  );
  const code = (dimension: string) => {
    const found = tags.find((tag) => tag.name === `W318虚构${dimension}`);
    if (!found) throw new Error("素材写页缺少真实字典前置");
    return found.code;
  };
  const reviewBody = {
    contentTagCodes: [code("content")],
    usageTagCodes: [code("usage")],
    timeliness: { tagCode: code("timeliness") },
  };
  const create = async (textBody: string) => {
    const created = await runtime.media.assets.create(actor, {
      storeId: merchant.store.id,
      type: "text",
      textBody,
    });
    for (let step = 0; step < 8; step++) {
      const detail = AdminStoreAssetDetailSchema.parse(
        await runtime.media.assets.get(actor, created.storeAssetId),
      );
      if (detail.processingState === "processed") return detail;
      const jobs = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: {
            parentType: "store_asset",
            parentId: created.storeAssetId,
            state: "queued",
            nextRunAt: { lte: runtime.clock.now() },
          },
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      );
      if (!jobs.length) throw new Error("素材写页没有可执行的本轮任务");
      for (const job of jobs) await runtime.media.jobs.run({ jobId: job.id });
    }
    throw new Error("素材写页任务未在有限步骤内收尾");
  };
  const review = await create("W318虚构咖啡店复核文字，服务端缺少模型配置时仍可人工整理。");
  const portrait = await create("W318虚构肖像授权说明，不含真实人物或个人资料。");
  await runtime.media.assets.review(actor, portrait.storeAssetId, {
    ...reviewBody,
    lockVersion: portrait.lockVersion,
    usability: "need_portrait_auth",
  });
  return {
    scope: {
      runId,
      name,
      prefix: `lyx:test:admin_live_${runId}:`,
      startedAt,
      storeId: merchant.store.id,
      staffId: staff.id,
    },
    storeId: merchant.store.id,
    staffId: staff.id,
    reviewId: review.storeAssetId,
    portraitId: portrait.storeAssetId,
    reviewBody,
  };
};
export default fixture;
