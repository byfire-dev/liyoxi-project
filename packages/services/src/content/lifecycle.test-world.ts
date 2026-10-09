// Database unit fixture: explicit stored/check facts; this does not establish real probe or cloud processing.
import { STAFF_ROLE_DEFAULTS, defaultRoleActions } from "@liyoxi/contract";
import { buildStaffContext, normalizeRoleConfig } from "../authz/index.js";
import { insertDictItemsMissing } from "../config/index.js";
import { lockRows, uuidv7 } from "../kernel/index.js";
import { DEMO_DICT_ITEMS } from "./demo-seed.js";
import { commitUploadMasters } from "./upload-masters.js";
import { revisionsWorld } from "./revisions.test-world.js";
import type { useSeededDatabase } from "../testing/index.js";
export async function lifecycleWorld(db: ReturnType<typeof useSeededDatabase>) {
  const h = await revisionsWorld(db),
    now = h.clock.now();
  await h.tx.run((tx) => insertDictItemsMissing(tx, DEMO_DICT_ITEMS, now));
  const role = STAFF_ROLE_DEFAULTS.find((v) => v.key === "super_admin")!;
  const staff = buildStaffContext({
    staff: { id: h.employee.id, roleKey: "super_admin", isLead: true, staffGroupId: null },
    role: normalizeRoleConfig("super_admin", {
      moduleLevels: role.moduleLevels,
      dataScope: role.dataScope,
      actions: defaultRoleActions("super_admin"),
    }),
    groupStaffIds: [],
    stepUpAt: null,
  });
  async function draft(total = 2) {
    let drama = await h.tx.run((tx) =>
      h.content.createDraft(tx, h.actor.identity, { title: "完整内容单元样本" }),
    );
    const poster = await h.make.fileObject({ category: "poster", moderationState: "pass" });
    drama = await h.tx.run((tx) =>
      h.content.saveBasic(tx, h.actor.identity, drama.id, {
        lockVersion: drama.lockVersion,
        totalEpisodes: total,
        posterFileId: poster.id,
        genreCodes: ["G01"],
        synopsis: "测试完整基础信息",
        dramaClass: "class_3",
      }),
    );
    drama = await h.tx.run((tx) =>
      h.content.saveCommercial(tx, h.actor.identity, drama.id, {
        lockVersion: drama.lockVersion,
        heatTier: "A",
        allowedPlacements: ["opening"],
        industryCodes: ["C01"],
      }),
    );
    const proof = await h.proof();
    const permit = await h.tx.run((tx) =>
      h.content.createPermit(tx, h.actor.identity, drama.id, {
        platform: "all",
        permitKind: "program_no",
        permitNo: "UNIT-001",
        scanFileIds: [proof.id],
      }),
    );
    await h.tx.run((tx) =>
      h.content.saveCopyrightDraft(tx, h.actor.identity, drama.id, {
        lockVersion: 0,
        source: "own",
        platforms: ["douyin"],
        territory: "中国大陆",
        hasNetworkRight: true,
        canSublicense: true,
        canEditEmbed: true,
        canAdapt: true,
        licenseStartDate: "2026-01-01",
        licenseEndDate: "2028-01-01",
        proofFileIds: [proof.id],
      }),
    );
    return {
      drama: await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } }),
      poster,
      proof,
      permit,
    };
  }
  async function masters(id: string, episodeNos: readonly number[], changed = false) {
    const drama = await h.prisma.drama.findUniqueOrThrow({ where: { id } });
    const batch = await h.prisma.uploadBatch.create({
      data: {
        id: uuidv7(),
        purpose: "drama_master",
        targetId: id,
        createdByStaffId: h.employee.id,
        state: "ready",
        expectedCount: drama.totalEpisodes!,
        scope: "partial",
        replaceReason: "quality_fix",
        isContentChanged: changed,
        idempotencyKey: uuidv7(),
        expiresAt: new Date(now.getTime() + 86400000),
        createdAt: now,
        updatedAt: now,
      },
    });
    const files: { episodeNo: number; fileId: string; durationMs: number }[] = [];
    for (const episodeNo of episodeNos) {
      const file = await h.make.fileObject({
        category: "drama_master",
        bucket: "media",
        ext: "mp4",
        mime: "video/mp4",
        declaredMime: "video/mp4",
        moderationState: "none",
      });
      await h.prisma.mediaCheck.create({
        data: {
          fileId: file.id,
          profile: "master",
          ruleVersion: 1,
          gate: "pass",
          hard: [],
          soft: [],
          checkedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      files.push({ episodeNo, fileId: file.id, durationMs: 20000 + episodeNo });
    }
    await h.tx.run(async (tx) => {
      await lockRows(tx, "drama", [id]);
      await lockRows(tx, "upload_batch", [batch.id]);
      const old = await tx.dramaEpisodeMaster.findMany({
        where: { dramaId: id, episodeNo: { in: [...episodeNos] }, isCurrent: true },
        select: { fileId: true },
      });
      await lockRows(tx, "file_object", [
        ...files.map((v) => v.fileId),
        ...old.map((v) => v.fileId),
      ]);
      await commitUploadMasters(
        tx,
        { clock: h.clock, media: h.media, events: h.events },
        { batch, staffId: h.employee.id, identity: h.actor.identity, items: files },
      );
      await tx.uploadBatch.update({
        where: { id: batch.id },
        data: { state: "committed", committedAt: now, updatedAt: now },
      });
    });
    return { batch, files };
  }
  const close = () => h.media.jobs.shutdown();
  return { ...h, staff, draft, masters, close };
}
export type LifecycleWorld = Awaited<ReturnType<typeof lifecycleWorld>>;
