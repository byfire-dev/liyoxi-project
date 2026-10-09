import { calendarDate } from "@liyoxi/shared/time";
import type { Prisma } from "@liyoxi/db";
import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { MachineBinding } from "../flow/index.js";
import { implementKeyed, lockRows, uuidv7 } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { DramaPrices } from "./ports.js";
import { listingChecks, assertListing, dateOf } from "./checks.js";

const binding: MachineBinding = {
  companions: [
    "first_listed_at",
    "listed_at",
    "updated_by_staff_id",
    "delisted_at",
    "delist_reason_code",
    "delist_note",
  ],
  activity: (facts) => ({
    category: "flow",
    action:
      facts.event === "drama.create"
        ? "content.drama.create"
        : facts.event === "drama.license_expire"
          ? "content.drama.license_expire"
          : facts.event === "drama.delist"
            ? "content.drama.delist"
            : "content.drama.list",
    summary:
      facts.event === "drama.create"
        ? "创建短剧草稿"
        : facts.event === "drama.license_expire"
          ? "授权到期，系统下架"
          : facts.event === "drama.delist"
            ? "下架短剧"
            : "通过上架校验，上架至短剧商城",
  }),
  guards: {
    [rowKey("05:146", "drama.license_expire")]: async (tx, facts) => {
      const row = await tx.dramaCopyright.findUnique({ where: { dramaId: facts.subjectId } });
      return Boolean(row?.licenseEndDate && calendarDate(facts.now) > dateOf(row.licenseEndDate)!);
    },
    [rowKey("05:144", "drama.list")]: async (tx, facts) => {
      const args = facts.args as { prices?: DramaPrices } | undefined;
      if (!args?.prices) throw new Error("drama.list 缺少本次装配的 DramaPricePort");
      assertListing(await listingChecks(tx, facts.subjectId, facts.now, args.prices));
      return true;
    },
    [rowKey("05:147", "drama.relist")]: async (tx, facts) => {
      const args = facts.args as { prices?: DramaPrices } | undefined;
      if (!args?.prices) throw new Error("drama.relist 缺少本次装配的 DramaPricePort");
      const drama = await tx.drama.findUnique({ where: { id: facts.subjectId } });
      if (!drama || drama.archivedAt) return false;
      assertListing(await listingChecks(tx, facts.subjectId, facts.now, args.prices));
      return true;
    },
  },
  effects: {
    [rowKey("05:144", "drama.list")]: async (tx, facts) => {
      const media = (facts.args as { media?: Pick<Media, "link"> } | undefined)?.media;
      if (!media || facts.ctx.actor.type !== "staff" || !facts.ctx.actor.id)
        throw new Error("drama.list 缺少媒体引用服务或员工");
      const c = await tx.dramaCopyright.findUniqueOrThrow({ where: { dramaId: facts.subjectId } });
      if (!c.licenseEndDate) throw new Error("上架校验放行了没有止日的版权");
      const id = uuidv7();
      const snapshot = {
        source: c.source,
        platforms: c.platforms,
        territory: c.territory,
        hasNetworkRight: c.hasNetworkRight,
        canSublicense: c.canSublicense,
        canEditEmbed: c.canEditEmbed,
        canAdapt: c.canAdapt,
        licenseStartDate: c.licenseStartDate?.toISOString().slice(0, 10) ?? null,
        licenseEndDate: c.licenseEndDate.toISOString().slice(0, 10),
        proofFileIds: c.proofFileIds,
      };
      await tx.dramaCopyrightRevision.create({
        data: {
          id,
          dramaId: facts.subjectId,
          changeKind: "initial",
          copyrightSnapshot: snapshot as Prisma.InputJsonValue,
          prevEndDate: null,
          newEndDate: c.licenseEndDate,
          reason: "首次上架",
          proofFileIds: c.proofFileIds,
          createdByStaffId: facts.ctx.actor.id,
          createdAt: facts.now,
        },
      });
      await tx.dramaCopyright.update({
        where: { dramaId: facts.subjectId },
        data: {
          currentDramaCopyrightRevisionId: id,
          lockVersion: { increment: 1 },
          updatedAt: facts.now,
        },
      });
      await lockRows(tx, "file_object", c.proofFileIds);
      for (const fileId of c.proofFileIds)
        await media.link(tx, {
          fileId,
          refType: "drama_copyright_revision",
          refId: id,
          role: "proof",
          entityId: null,
          storeId: null,
        });
    },
  },
};
export const contentMachine = implementKeyed(machinePort, chainKey("drama", "status"), binding);
