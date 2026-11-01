import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLedger } from "../../billing/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { base32Decode, hotp, issueActivationCode, totpStep } from "../../staff/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import type { Runtime } from "../../runtime.js";
import type { AdminLiveFixture } from "./context.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
const ScopeSchema = z
  .strictObject({
    runId: z.string().regex(/^[a-f0-9]{16}$/),
    name: z.string(),
    prefix: z.string(),
    startedAt: z.iso.datetime(),
    entityId: z.string().uuid(),
    storeId: z.string().uuid(),
    editorId: z.string().uuid(),
    adIds: z
      .array(z.string().uuid())
      .length(3)
      .refine((ids) => new Set(ids).size === 3),
  })
  .refine(
    (scope) =>
      scope.name === `lyx_test_admin_live_${scope.runId}` &&
      scope.prefix === `lyx:test:admin_live_${scope.runId}:`,
  );
export type AdTaskLiveScope = z.infer<typeof ScopeSchema>;
export function parseAdTaskLiveScope(raw: unknown) {
  return ScopeSchema.parse(raw);
}
export function assertAdTaskLiveScope(runtime: Pick<Runtime, "env">, raw: unknown) {
  const actual = assertDeliveryLiveEnvironment(runtime.env),
    scope = ScopeSchema.parse(raw);
  if (
    scope.name !== actual.name ||
    scope.runId !== actual.runId ||
    scope.prefix !== actual.prefix ||
    new Set(scope.adIds).size !== 3
  )
    throw new Error("W514 scope不属于本轮隔离库");
  return scope;
}
/** Only jobs for this run's three ads, uploaded by its exact editor; no global media scan. */
export async function findAdTaskLiveJobIds(runtime: Runtime, raw: unknown) {
  const scope = assertAdTaskLiveScope(runtime, raw);
  return runtime.tx.run(async (tx) => {
    const ads = await tx.ad.count({
      where: {
        id: { in: scope.adIds },
        entityId: scope.entityId,
        storeId: scope.storeId,
        createdAt: { gte: new Date(scope.startedAt) },
      },
    });
    if (ads !== 3) throw new Error("W514广告范围已变化");
    const files = await tx.fileObject.findMany({
      where: {
        category: "ad_video",
        entityId: scope.entityId,
        storeId: scope.storeId,
        scopeType: "store",
        uploadActorType: "staff",
        uploadActorId: scope.editorId,
        uploadClient: "admin",
        createdAt: { gte: new Date(scope.startedAt) },
        productionRecord: {
          kind: "ad",
          adId: { in: scope.adIds },
          uploadedByStaffId: scope.editorId,
        },
      },
      select: { id: true },
    });
    const jobs = await tx.mediaJob.findMany({
      where: {
        subjectType: "file_object",
        subjectId: { in: files.map((f) => f.id) },
        kind: { in: ["promote", "probe", "thumbnail"] },
        state: { in: ["queued", "running", "submitting", "submitted"] },
        nextRunAt: { lte: runtime.clock.now() },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: 20,
      select: { id: true },
    });
    return jobs.map((job) => job.id);
  });
}
/** Generate actual legal 3s input in the existing pinned CPU1 tool; no fabricated report or DB media fact. */
export function prepareAdTaskLiveVideo(image: string, directory: string, runId: string) {
  if (!/^[a-f0-9]{16}$/.test(runId) || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("W514只接受本轮mediatool与临时目录");
  const expected = realpathSync(
    fileURLToPath(
      new URL(`../../../../../apps/admin/dist/tmp/admin-live-${runId}`, import.meta.url),
    ),
  );
  if (realpathSync(directory) !== expected) throw new Error("W514只接受本轮mediatool与临时目录");
  const script = `import {execFileSync} from 'node:child_process'; import{readFileSync,mkdirSync}from'node:fs'; import{createHash}from'node:crypto';import{probe}from'/app/ops.mjs';
mkdirSync('/work/w514',{mode:0o700});const version=execFileSync('ffmpeg',['-hide_banner','-version'],{encoding:'utf8'}).split('\\n')[0];if(!version.startsWith('ffmpeg version 5.1.9'))throw Error('fixed tool required');
execFileSync('ffmpeg',['-hide_banner','-v','error','-nostdin','-n','-filter_threads','1','-filter_complex_threads','1','-f','lavfi','-i','testsrc2=size=1080x1920:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-map','0:v:0','-map','1:a:0','-t','3','-vf','drawtext=fontfile=/app/fonts/NotoSansCJKsc-Regular.otf:text=广告:fontcolor=white:fontsize=72:x=48:y=48:box=1:boxcolor=black@0.6:boxborderw=16','-c:v','libx264','-preset','veryfast','-profile:v','high','-pix_fmt','yuv420p','-threads','1','-crf','23','-c:a','aac','-b:a','128k','-ac','2','-movflags','+faststart','-f','mp4','/work/w514/ad.mp4'],{timeout:120000,stdio:['ignore','ignore','inherit']});
const report=await probe({path:'w514/ad.mp4',demuxers:['mov']});const raw=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json','/work/w514/ad.mp4'],{encoding:'utf8',timeout:10000}));const bytes=readFileSync('/work/w514/ad.mp4');process.stdout.write(JSON.stringify({version,bytes:bytes.toString('base64'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),report,raw}));`;
  const container = `lyx-w514-media-${runId}`;
  let output: string;
  try {
    output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        container,
        "--label",
        `lyx.test.run=${runId}`,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "1",
        "--memory",
        "1g",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--tmpfs",
        "/work:rw,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
        "--interactive",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
      ],
      { input: script, encoding: "utf8", timeout: 150000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    let label: string | undefined;
    try {
      label = execFileSync(
        "docker",
        ["inspect", "--format", '{{index .Config.Labels "lyx.test.run"}}', container],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      /* --rm already removed the exact container. */
    }
    if (label !== undefined) {
      if (label !== runId) throw new Error("W514造片容器归属不符，保留对象");
      execFileSync("docker", ["stop", "--time", "10", container], {
        timeout: 20000,
        stdio: "ignore",
      });
    }
    throw new Error("W514实际造片失败，未标记媒体成功");
  }
  const result = JSON.parse(output);
  const evidence = z
    .object({
      bytes: z.string(),
      size: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      report: z.object({
        report: z.object({
          format: z.object({ durationMs: z.number().int().min(2950).max(3050) }),
          moovBeforeMdat: z.literal(true),
        }),
      }),
      raw: z.object({
        streams: z.array(
          z.object({
            codec_type: z.string(),
            width: z.number().optional(),
            height: z.number().optional(),
            codec_name: z.string(),
          }),
        ),
      }),
    })
    .parse(result);
  const bytes = Buffer.from(evidence.bytes, "base64"),
    video = evidence.raw.streams.filter((s) => s.codec_type === "video");
  if (
    bytes.length !== evidence.size ||
    createHash("sha256").update(bytes).digest("hex") !== evidence.sha256 ||
    video.length !== 1 ||
    video[0]!.width !== 1080 ||
    video[0]!.height !== 1920 ||
    video[0]!.codec_name !== "h264"
  )
    throw new Error("W514实际媒体证明不符");
  const path = join(directory, `w514-ad-${runId}.mp4`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(
    join(directory, `w514-ad-${runId}.probe.json`),
    JSON.stringify({ ...result, bytes: undefined }),
    { flag: "wx", mode: 0o600 },
  );
  return {
    path,
    size: evidence.size,
    sha256: evidence.sha256,
    durationMs: evidence.report.report.format.durationMs,
  };
}
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const scope = assertDeliveryLiveEnvironment(runtime.env),
    startedAt = runtime.clock.now().toISOString();
  const group = await runtime.tx.run((tx) =>
    tx.staffGroup.findFirstOrThrow({ where: { staffRoleKey: "editor", isDefault: true } }),
  );
  const editor = await make.staff({
    name: "W514广告剪辑师",
    staffRoleKey: "editor",
    staffGroupId: group.id,
  });
  const phone = openField(loadKeyring(runtime.env), "staff.phone_enc", editor.phoneEnc),
    password = "W514-Fictional-ok";
  const issued = await runtime.tx.run((tx) =>
    issueActivationCode(tx, {
      staffId: editor.id,
      purpose: "activate",
      delivery: "manual",
      createdByStaffId: null,
      now: runtime.clock.now(),
    }),
  );
  const active = await runtime.staffAuth.activate({ phone, activationCode: issued.code });
  if (!active.ticket) throw new Error("W514激活票据缺失");
  const meta = { ip: "127.0.0.1", userAgent: "lyxtest W514" };
  const changed = await runtime.staffAuth.setPassword({
    ticket: active.ticket,
    newPassword: password,
    meta,
  });
  if (!changed.ticket) throw new Error("W514密码票据缺失");
  const enrolled = await runtime.staffAuth.enrollTotp({ ticket: changed.ticket });
  const signed = await runtime.staffAuth.confirmTotp({
    ticket: enrolled.ticket,
    code: hotp(base32Decode(enrolled.secret), totpStep(runtime.clock.now())),
    meta,
  });
  const poolOwner = await runtime.tx.run(async (tx) => {
    const admin = await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    });
    return {
      admin,
      staff: await sampleStaffContext(tx, admin.id, { stepUpAt: runtime.clock.now() }),
      editor: await tx.staff.findUniqueOrThrow({ where: { id: editor.id } }),
    };
  });
  await runtime.staffManagement.replacePools(
    poolOwner.staff,
    createIdentityContext({ actor: { type: "staff", id: poolOwner.admin.id, client: "admin" } }),
    editor.id,
    { memberships: [{ pool: "editor" }], lockVersion: poolOwner.editor.lockVersion },
  );
  const merchant = await make.subscribedMerchant();
  await runtime.tx.run((tx) =>
    tx.store.update({
      where: { id: merchant.store.id },
      data: { name: `W514广告门店-${scope.runId}` },
    }),
  );
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
  });
  const actor = {
    ctx,
    membership: {
      memberId: merchant.owner.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  // Historical profile inputs, matching the existing order fixture boundary; no advertising state is seeded.
  await runtime.tx.run(async (tx) => {
    for (const row of [
      {
        dictTypeKey: "industry",
        code: "W514I",
        parentCode: null,
        ext: { open: true, special: false, requiredCerts: [] },
      },
      {
        dictTypeKey: "industry",
        code: "W514C",
        parentCode: "W514I",
        ext: { open: true, special: false, requiredCerts: [] },
      },
      ...["W514P", "W514M", "W514D"].map((code, index) => ({
        dictTypeKey: "region",
        code,
        parentCode: index ? ["W514P", "W514M"][index - 1]! : null,
        ext: { level: index + 1, functionalZone: false, opened: true },
      })),
    ])
      await tx.dictItem.upsert({
        where: { dictTypeKey_code: { dictTypeKey: row.dictTypeKey, code: row.code } },
        create: {
          id: uuidv7(),
          ...row,
          name: row.code,
          isEnabled: true,
          position: 999,
          createdAt: runtime.clock.now(),
          updatedAt: runtime.clock.now(),
        },
        update: {},
      });
    await tx.storeProfile.create({
      data: {
        storeId: merchant.store.id,
        entityId: merchant.entity.id,
        brandName: "广告演练品牌",
        industryCode: "W514I",
        categoryCode: "W514C",
        provinceCode: "W514P",
        cityCode: "W514M",
        districtCode: "W514D",
        addressDetail: "隔离测试路一号",
        businessHours: [{ start: "09:00", end: "18:00" }],
        storeTel: "01012345678",
        avgSpendFen: 1000,
        sellingPointCodes: ["service"],
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
    });
    await tx.storeServiceItem.create({
      data: {
        id: uuidv7(),
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        name: "广告演练服务",
        priceFen: 1000,
        position: 1,
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
    });
  });
  for (let index = 0; index < 4; index++) {
    const file = await make.fileObject({
      category: "profile_image",
      bucket: "asset",
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      scopeType: "store",
    });
    await runtime.tx.run((tx) =>
      tx.storeProfileMedia.create({
        data: {
          id: uuidv7(),
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          fileId: file.id,
          mediaGroup: index === 0 ? "door" : "interior",
          position: index === 0 ? 1 : index,
          mediaKind: "image",
          createActorType: "merchant",
          createActorId: merchant.user.id,
          createClient: "weapp",
          createdAt: runtime.clock.now(),
          updatedAt: runtime.clock.now(),
        },
      }),
    );
  }
  // Historical active subscription is an upstream input; its pending schedule is granted by the actual ledger.
  const schedule = await runtime.tx.run((tx) =>
    tx.grantSchedule.create({
      data: {
        id: uuidv7(),
        subscriptionTermId: merchant.term.id,
        entityId: merchant.entity.id,
        monthNo: 0,
        dueAt: merchant.term.startsAt,
        dueDate: merchant.term.startDate,
        points: merchant.term.monthlyPoints,
        valueFen: merchant.term.priceTotalFen,
        planId: merchant.term.planId,
        planRevisionId: merchant.term.planRevisionId,
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
    }),
  );
  await runtime.tx.run((tx) =>
    createLedger(runtime).grant(tx, { grantScheduleId: schedule.id, ctx }),
  );
  const current = await runtime.tx.run((tx) => runtime.docs.currentVersions(tx));
  if (!current.has("ad_service")) {
    const admin = await runtime.tx.run((tx) =>
      tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
    );
    await make.agreementVersion({ agreementKey: "ad_service", createdByStaffId: admin.id });
  }
  const quote = await runtime.ads.quote(actor, { type: "opening", durationSec: 3 });
  if (
    quote.chargePoints === null ||
    quote.blockers.length ||
    !quote.typeOptions.some((t) => t.type === "opening" && t.durationOptions.includes(3))
  )
    throw new Error("W514广告真实报价不可创建3秒需求");
  const promo = await runtime.tx.run((tx) =>
    tx.dictItem.findFirstOrThrow({ where: { dictTypeKey: "ad_promo_point", isEnabled: true } }),
  );
  const ads = [];
  for (let i = 0; i < 3; i++)
    ads.push(
      await runtime.ads.create(actor, {
        type: "opening",
        durationSec: 3,
        promoPointCodes: [promo.code],
        expectChargePoints: quote.chargePoints,
        agreementVersionId: quote.agreement.agreementVersionId,
        isAgreementChecked: true,
      }),
    );
  return {
    scope: {
      ...scope,
      startedAt,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      editorId: editor.id,
      adIds: ads.map((a) => a.adId),
    },
    ads,
    editor: {
      staffId: editor.id,
      name: editor.name,
      roleKey: editor.staffRoleKey,
      status: editor.status,
      phone,
      password,
      recoveryCode: signed.recoveryCodes[0],
    },
  };
};
export default fixture;
