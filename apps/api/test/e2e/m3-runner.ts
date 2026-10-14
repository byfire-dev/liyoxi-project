import assert from "node:assert/strict";
import type { M3Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";
import { createM1Caller } from "./runner-api.js";
import { ensureM3Content, verifyM3ContentMall } from "./m3-content.js";
import type { M3ContentReport } from "./m3-content.js";
import { createM3Assets, verifyM3AssetUsage } from "./m3-assets.js";
import type { M3AssetsReport } from "./m3-assets.js";
import { verifyM3ProfileBlock, verifyM3Retention } from "./m3-checks.js";
import { verifyM3Aigc } from "./m3-aigc.js";

export async function runM3Chain(input: {
  readonly api: M1Api;
  readonly support: M3Support;
  readonly say?: (message: string) => void;
}) {
  const { api, support, say = () => {} } = input;
  const call = createM1Caller(api),
    demoKey = `m3-${support.runId}`;
  let content: M3ContentReport | undefined, assets: M3AssetsReport | undefined;
  let retention: Awaited<ReturnType<typeof verifyM3Retention>> | undefined;
  let profile: Awaited<ReturnType<typeof verifyM3ProfileBlock>> | undefined;
  let usages: Awaited<ReturnType<typeof verifyM3AssetUsage>> | undefined;
  let aigc: Awaited<ReturnType<typeof verifyM3Aigc>> | undefined;
  let replay: { readonly inserted: number; readonly dictionaryPreserved: true } | undefined;
  // 识别字段与图像均为虚构测试输入；真实 OCR 结果的加密、回显与人工核对走正式接口。
  support.providers.ocr.defaultLicense = {
    name: "M3虚构经营主体",
    uscc: "91310000MA1K00001X",
    principal: "演示负责人",
    subjectType: "enterprise",
    principalRole: "legal_rep",
    address: "演示路一号",
    validFrom: "2020-01-01",
    validTo: "long_term",
    warnings: [],
  };
  const chain = await runM1Chain({
    api,
    support,
    say,
    episodeCount: 2,
    uploadConcurrency: 1,
    async seedDemo(admin) {
      say("小样本非法文件头、跨日清单审批与真实清除");
      retention = await verifyM3Retention(api, support, admin);
      const seeded = await support.seedPrerequisites();
      say("后台接口建剧、两集原片提交与体检上架");
      content = await ensureM3Content({ api, support, adminHeaders: admin.headers, demoKey });
      return seeded;
    },
    async qualificationDoc({ result, fileId }) {
      assert.equal(result.doc.ocrStatus, "ok");
      assert.equal(result.recognized?.name, support.providers.ocr.defaultLicense.name);
      assert.equal(result.entityTypeCheck?.isMismatch, false);
      const facts = await support.readFacts({ fileIds: [fileId] });
      assert.equal(facts.ocr.length, 1);
      assert.equal(facts.ocr[0]!.status, "ok");
      assert.equal(facts.ocr[0]!.hasFields, true);
      assert.equal(support.providers.ocr.callsOf("recognizeBusinessLicense").length, 1);
    },
    async beforeOrder(context) {
      assert.ok(content);
      await verifyM3ContentMall(api, context.owner.headers, content);
      say("素材预算未配置降级、配置理解、人工整理与肖像授权");
      assets = await createM3Assets(context, support);
      return assets.referenceAssetIds;
    },
    async beforeEpisodes(context) {
      say("制作缺标拒绝、正式补标派生与七字段读回一致");
      aigc = await verifyM3Aigc(context, support);
    },
    async afterChain(context) {
      assert.ok(content && assets);
      usages = await verifyM3AssetUsage(
        context,
        assets,
        context.scope.orderId,
        context.scope.orderItemId,
      );
      const outputs = await call("admin.deliveryTicket.episodeOutput.list", context.admin.headers, {
        params: { deliveryTicketId: context.scope.deliveryTicketId },
      });
      assert.equal(outputs.episodes.length, 2);
      const current = outputs.episodes.map((episode) => {
        assert.ok(episode.current, "每一集必须有真实当前成片");
        return episode.current;
      });
      for (const output of current) {
        assert.equal(output.production?.pipelineState, "ready");
        assert.equal(output.production?.gate, "pass");
        assert.equal(output.qc?.verdict, "pass");
      }
      const state = await support.readState({ ...context.scope, sampleId: context.sampleId });
      assert.ok(state.sample);
      const facts = await support.readFacts({
        fileIds: [state.sample.fileId, ...current.map((one) => one.fileId)],
      });
      assert.equal(facts.production.length, 3);
      assert.ok(
        facts.jobs.some((job) => job.kind === "watermark_sample" && job.state === "succeeded"),
      );
      assert.ok(
        facts.events.filter((event) => event.eventType === "media.production.checked").length >= 3,
      );
      assert.ok(
        support.providers.media.callsOf("describe").length > 0,
        "未投递回调，真实任务须依赖上游 describe 回查完成",
      );

      // 同一隔离库内复用相同演示意图，比较真实业务数量与字典，而非只返回常量零。
      const scope = { dramaIds: [content.dramaId], assetIds: assets.referenceAssetIds };
      const before = await support.readFacts(scope);
      const dictionaries = await call("admin.dictItem.list", context.admin.headers, {
        query: { typeKey: "genre,industry", includeDisabled: true },
      });
      const seeded = await support.seedPrerequisites();
      const repeated = await ensureM3Content({
        api,
        support,
        adminHeaders: context.admin.headers,
        merchantHeaders: context.owner.headers,
        demoKey,
      });
      assert.equal(seeded.inserted, 0);
      assert.equal(repeated.inserted, 0);
      assert.equal(repeated.dramaId, content.dramaId);
      assert.deepEqual((await support.readFacts(scope)).counts, before.counts);
      assert.deepEqual(
        await call("admin.dictItem.list", context.admin.headers, {
          query: { typeKey: "genre,industry", includeDisabled: true },
        }),
        dictionaries,
      );
      replay = { inserted: seeded.inserted + repeated.inserted, dictionaryPreserved: true };
      say("演示第二遍零新增；档案图片真实 block 后核对完整度下降");
      profile = await verifyM3ProfileBlock(context, support);
    },
  });
  assert.ok(content && assets && retention && profile && usages && replay && aigc);
  return { ...chain, content, assets, retention, profile, usages, replay, aigc };
}
