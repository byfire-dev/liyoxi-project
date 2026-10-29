// M3 的 AIGC 事实链：HTTP 登记文件，正式媒体任务产出事实；不改业务表。
// codec/stamp 字节为 typed 外部 IO 替身；native 七字段证据沿 W3-04，不冒称云/ffmpeg 演练。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { media } from "@liyoxi/services";
import type { M1Scope, M3Support } from "@liyoxi/services/testing";
import { createM1Caller } from "./runner-api.js";
import type { M1ChainContext } from "./runner.js";

/** 必须在真实 batch_compose/delivering 且尚未交付时调用；不放宽已交付上传守卫。 */
export async function verifyM3Aigc(
  context: M1ChainContext & { readonly scope: M1Scope },
  support: M3Support,
) {
  assert.equal(context.api.support, support);
  const call = createM1Caller(context.api),
    video = support.productionVideo,
    tools = [{ name: "M3虚构工具", version: "1", usedFor: "仅隔离测试的补标声明" }];
  const registered = await call("admin.file.create", context.admin.headers, {
    body: {
      category: "final_episode",
      storeId: context.owner.storeId,
      fileName: `m3-aigc-${support.runId}.mp4`,
      mime: "video/mp4",
      sizeBytes: String(video.sizeBytes),
      clientToken: randomUUID(),
      production: {
        kind: "final",
        orderItemId: context.scope.orderItemId,
        episodeNo: 1,
        aiUsage: { used: true, tools },
      },
    },
  });
  assert.equal(registered.mode, "post");
  assert.ok(registered.post);
  assert.equal(
    support.providers.storage.upload(
      { ...registered.post, key: registered.key, expiresAt: new Date(registered.expiresAt) },
      video.bytes,
    ),
    204,
  );
  const fileId = registered.fileId;
  await call("admin.file.complete", context.admin.headers, { params: { fileId }, body: {} });
  await support.promote(fileId);
  // M5 recheck/restamp HTTP 仍是 metadata 占位；这里只运输已合公开服务，不称已落地。
  const probeId = await support.runtime.tx.run((tx) =>
    support.runtime.media.enqueueProbe(tx, fileId),
  );
  await support.runtime.media.jobs.run({ jobId: probeId });
  const missing = await support.readFacts({ fileIds: [fileId] }),
    source = missing.production.find((record) => record.fileId === fileId),
    check = missing.checks.find((row) => row.fileId === fileId),
    probed = missing.jobs.find((job) => job.id === probeId);
  assert.ok(source && check && probed);
  assert.equal(probed.state, "succeeded", "探测执行成功与制作体检通过是不同事实");
  const original = media.ProbeOutputSchema.parse(probed.output);
  assert.equal(original.technical.aigcMeta, null);
  assert.equal(original.technical.invalidAigc, false);
  assert.equal(check.gate, "reject");
  assert.equal(source.pipelineState, "rejected");
  assert.equal(source.aigcState, "failed");
  assert.deepEqual(source.aiUsage, {
    used: true,
    tools,
    declaredBy: context.admin.staffId,
    declaredAt: source.createdAt.toISOString(),
    forcedByDrama: false,
  });
  const rejected = await support.runtime.tx.run((tx) =>
    support.runtime.media.deliveryProductionFacts(tx, fileId),
  );
  assert.equal(rejected.valid, true);
  assert.equal(rejected.ready, false);
  assert.equal(rejected.gate, "reject");
  // 正式 facts 只有缺标且失败项全部为 H7 时才允许等待补标，不能用普通失败代替。
  assert.equal(rejected.awaitingRestamp, true);
  const automatic = missing.jobs.filter(
    (job) => job.subjectId === fileId && job.kind === "restamp",
  );
  assert.equal(automatic.length, 1);
  assert.equal(automatic[0]!.state, "queued");

  const restampId = await support.runtime.tx.run((tx) => support.runtime.media.restamp(tx, fileId));
  assert.equal(restampId, automatic[0]!.id, "人工补标须复用当前上下文已排队的正式意图");
  await support.runtime.media.jobs.run({ jobId: restampId });
  const stamped = await support.readFacts({ fileIds: [fileId] }),
    restamp = stamped.jobs.find((job) => job.id === restampId);
  assert.ok(restamp);
  assert.equal(restamp.state, "succeeded");
  const output = media.DerivationOutputSchema.parse(restamp.output),
    derivedId = output.fileId;
  assert.notEqual(derivedId, fileId, "补标必须新建派生文件，不覆盖原片");
  await support.drainMedia({ fileIds: [fileId, derivedId] });
  const after = await support.readFacts({ fileIds: [fileId, derivedId] }),
    derived = after.production.find((record) => record.fileId === derivedId),
    derivedFile = after.files.find((row) => row.id === derivedId),
    info = after.metadata.find((row) => row.fileId === derivedId),
    derivedProbe = after.jobs.find((job) => job.subjectId === derivedId && job.kind === "probe"),
    config = support.runtime.env.MEDIA_PRODUCTION;
  assert.ok(derived && derivedFile && info && derivedProbe && config);
  assert.ok("aigc" in config, "AIGC 合流验收需要完整媒体生产配置");
  assert.equal(derivedFile.status, "stored");
  assert.equal(derived.source, "restamped");
  assert.equal(derived.derivedFromFileId, fileId);
  assert.deepEqual(derived.aiUsage, source.aiUsage);
  assert.equal(derived.orderItemId, context.scope.orderItemId);
  assert.equal(derived.episodeNo, 1);
  assert.equal(derived.pipelineState, "ready");
  assert.equal(derived.aigcState, "verified");
  assert.equal(derived.aigcOrigin, "stamped");
  assert.equal(derivedProbe.state, "succeeded");
  const expected = {
    ...config.aigc,
    ProduceID: media.systemProduceId(derivedId),
    PropagateID: config.aigc.ContentPropagator ? media.systemProduceId(derivedId) : "",
  };
  assert.equal(Object.keys(expected).length, 7);
  assert.deepEqual(output.technical.aigcMeta, expected);
  assert.deepEqual(info.aigcMeta, expected);
  assert.deepEqual(media.ProbeOutputSchema.parse(derivedProbe.output).technical.aigcMeta, expected);
  const object = support.providers.storage.objects.get(
    `${derivedFile.bucket}/${derivedFile.objectKey}`,
  );
  assert.ok(object);
  assert.equal(createHash("sha256").update(object.body).digest("hex"), derivedFile.sha256);
  assert.equal(BigInt(object.body.length), derivedFile.sizeBytes);
  // 这是明确 typed IO 的可见输出字节，不把附加 JSON 字节称为 native MP4 标识实现。
  assert.deepEqual(
    JSON.parse(Buffer.from(object.body.slice(video.sizeBytes)).toString("utf8")),
    expected,
  );
  const ready = await support.runtime.tx.run((tx) =>
    support.runtime.media.deliveryProductionFacts(tx, derivedId),
  );
  assert.equal(ready.valid, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.gate, "pass");
  assert.ok(
    after.refs.some(
      (ref) =>
        ref.fileId === fileId &&
        ref.refType === "production_record" &&
        ref.refId === derivedId &&
        ref.role === "source" &&
        ref.state === "live",
    ),
  );
  assert.deepEqual(
    after.production.find((record) => record.fileId === fileId),
    source,
    "补标保留原声明与缺标事实",
  );
  assert.ok(
    after.events.some(
      (event) => event.aggregateId === derivedId && event.eventType === "media.production.derived",
    ),
  );
  assert.ok(
    after.events.some(
      (event) => event.aggregateId === derivedId && event.eventType === "media.production.checked",
    ),
  );
  assert.equal(
    (await call("admin.file.get", context.admin.headers, { params: { fileId: derivedId } })).status,
    "stored",
  );
  return {
    fileId,
    derivedFileId: derivedId,
    missingLabelRejected: true,
    aigcState: "verified",
    transport: "http_file_and_public_media_jobs",
    nativeStamp: false,
  } as const;
}
