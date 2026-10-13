import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { profileCloseFactsPort } from "../tenant/index.js";
import {
  countQualificationSubmissionsInReview,
  countUnverifiedPrimaryStore,
} from "./close-facts.js";
import { staffWorkPort, staffFollowUpPort } from "../kernel/index.js";
import { onFileModerated } from "./file-moderated.js";
import { profileStaffWork } from "./staff-work.js";
import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import { storeForNotify } from "./notify-facts.js";
import { profilePiiFields } from "./pii-fields.js";
import { approvalKindPort } from "../approval/index.js";
import {
  defineRegistration,
  fileRefTypePort,
  implementKeyed,
  implementMerchantFacts,
} from "../kernel/index.js";
import type { ExpectedFileRef } from "../kernel/index.js";
import type { ClockBoundFileRefType } from "../media/index.js";
import { findViolations, PROFILE_INVARIANT_CODES } from "./invariants.js";
import { adminProfileFactsPort } from "./admin-ports.js";
import { deliveryManagerPort, orderManagerPort, QualificationImpactPort } from "./ports.js";
import { qualificationKind } from "./qualification-kind.js";
import { PROFILE_TENANT_EVENTS, unboundTenantLifecycle } from "./tenant-lifecycle.js";
import { dictRef, snapshot } from "./repo.js";
import {
  PROFILE_APPROVED_EVENTS,
  unboundQualificationConsistency,
} from "./qualification-consistency.js";

const qualificationDocRef: ClockBoundFileRefType = {
  async inUse() {
    throw new TypeError("资质证照在用事实须绑定 media 业务时钟");
  },
  withClock(clock) {
    return {
      ...this,
      async inUse(tx, fileId) {
        const cutoff = new Date(clock.now().getTime()),
          month = cutoff.getUTCMonth();
        cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
        if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
        const rows = await tx.qualificationDoc.findMany({
          where: { fileId },
          select: {
            id: true,
            removedAt: true,
            supersededAt: true,
            qualificationSubmission: { select: { submittedAt: true, closedAt: true } },
            entity: { select: { lifecycle: true, closedAt: true } },
          },
        });
        return rows
          .filter((row) => {
            const submittedAt = row.qualificationSubmission.submittedAt;
            // 送审前已移除的草稿行不属于该轮提交证据；送审后的历史证据不因取代而释放。
            if (submittedAt && (row.removedAt === null || row.removedAt >= submittedAt))
              return !(
                row.entity.lifecycle === "closed" &&
                row.entity.closedAt !== null &&
                row.entity.closedAt <= cutoff
              );
            return (
              row.removedAt === null &&
              row.supersededAt === null &&
              row.qualificationSubmission.closedAt === null &&
              row.entity.lifecycle !== "closed"
            );
          })
          .map((row) => ({ fileId, refId: row.id, role: "main" }));
      },
    };
  },
  roles: {
    main: {
      categories: ["kyc_license", "kyc_permit"],
      retentionDays: 7,
      canRelease: async (tx, id) => {
        const doc = await tx.qualificationDoc.findUnique({
          where: { id },
          include: { entity: { select: { lifecycle: true } } },
        });
        return (
          !doc ||
          doc.removedAt !== null ||
          doc.supersededAt !== null ||
          doc.entity.lifecycle === "closed"
        );
      },
    },
  },
  readColumns: async (tx) =>
    (
      await tx.qualificationDoc.findMany({
        where: { removedAt: null, entity: { lifecycle: { not: "closed" } } },
        select: { id: true, fileId: true },
      })
    ).map((row): ExpectedFileRef => ({ fileId: row.fileId, refId: row.id, role: "main" })),
};

export const registration = defineRegistration("profile", {
  ports: [orderManagerPort, deliveryManagerPort, adminProfileFactsPort, QualificationImpactPort],
  subscribers: [
    {
      name: "profile.onQualificationApproved",
      events: PROFILE_APPROVED_EVENTS,
      handle: unboundQualificationConsistency,
    },
    {
      name: "profile.onTenantLifecycle",
      events: PROFILE_TENANT_EVENTS,
      handle: unboundTenantLifecycle,
    },
    { name: "profile.onFileModerated", events: ["file.moderated"], handle: onFileModerated },
  ],
  portImplementations: [
    implementTenantCloseFacts(profileCloseFactsPort, {
      countQualificationSubmissionsInReview,
      countUnverifiedPrimaryStore,
    }),
    implementKeyed(staffFollowUpPort, "store", async (tx, id) => {
      const row = await tx.store.findUnique({
        where: { id },
        select: { entityId: true, id: true },
      });
      return row === null ? null : { entityId: row.entityId, storeId: row.id };
    }),
    implementKeyed(staffWorkPort, "profile", profileStaffWork),
    notifyReaderImplementation(currentNotifyReadPort, "storeForNotify", storeForNotify),

    implementKeyed(dictReferencesPort, "profile", profileDictReferences),
    ...profilePiiFields,
    implementKeyed(approvalKindPort, "qualification", qualificationKind),
    implementMerchantFacts("profile", async (tx, query) => {
      const stores: Record<
        string,
        {
          city: Awaited<ReturnType<typeof dictRef>>;
          category: Awaited<ReturnType<typeof dictRef>>;
          verifiedAt: Date | null;
          submittedAt: Date | null;
          expectedDecisionAt: Date | null;
          completenessPct: number;
        }
      > = {};
      for (const storeId of query.storeIds) {
        const s = await snapshot(tx, storeId);
        if (s.store.entityId !== query.entityId)
          throw new TypeError("profile 事实查询的门店不属于主体");
        stores[storeId] = {
          city: await dictRef(tx, "region", s.profile?.cityCode),
          category: await dictRef(tx, "industry", s.profile?.categoryCode),
          verifiedAt: s.profile?.firstVerifiedAt ?? null,
          submittedAt: s.open?.submittedAt ?? null,
          expectedDecisionAt: s.open?.approvalRequest?.dueAt ?? null,
          completenessPct: s.completeness.pct,
        };
      }
      return { stores };
    }),
    implementKeyed(fileRefTypePort, "store_profile", {
      inUse: async (tx, fileId) =>
        (
          await tx.storeProfile.findMany({
            where: { logoFileId: fileId, entity: { lifecycle: { not: "closed" } } },
            select: { storeId: true },
          })
        ).map((row) => ({ fileId, refId: row.storeId, role: "logo" })),
      roles: { logo: { categories: ["profile_image"], retentionDays: 30 } },
      readColumns: async (tx) =>
        (
          await tx.storeProfile.findMany({
            where: { logoFileId: { not: null } },
            select: { storeId: true, logoFileId: true },
          })
        ).map((row) => ({ fileId: row.logoFileId!, refId: row.storeId, role: "logo" })),
    }),
    implementKeyed(fileRefTypePort, "store_profile_media", {
      inUse: async (tx, fileId) =>
        (
          await tx.storeProfileMedia.findMany({
            where: { fileId, removedAt: null, entity: { lifecycle: { not: "closed" } } },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "main" })),
      roles: {
        main: {
          categories: ["profile_image", "profile_video", "profile_promo"],
          retentionDays: 30,
        },
      },
      readColumns: async (tx) =>
        (
          await tx.storeProfileMedia.findMany({
            where: { removedAt: null },
            select: { id: true, fileId: true },
          })
        ).map((row) => ({ fileId: row.fileId, refId: row.id, role: "main" })),
    }),
    implementKeyed(fileRefTypePort, "store_service_item", {
      inUse: async (tx, fileId) =>
        (
          await tx.storeServiceItem.findMany({
            where: {
              imageFileId: fileId,
              removedAt: null,
              entity: { lifecycle: { not: "closed" } },
            },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "image" })),
      roles: { image: { categories: ["profile_image"], retentionDays: 30 } },
      readColumns: async (tx) =>
        (
          await tx.storeServiceItem.findMany({
            where: { removedAt: null, imageFileId: { not: null } },
            select: { id: true, imageFileId: true },
          })
        ).map((row) => ({ fileId: row.imageFileId!, refId: row.id, role: "image" })),
    }),
    implementKeyed(fileRefTypePort, "qualification_doc", qualificationDocRef),
  ],
  invariants: PROFILE_INVARIANT_CODES.map((code) => ({
    code: `profile.${code}`,
    severity: "P2",
    modes: ["full"],
    heal: code === "I6" || code === "I7" ? "heal_and_alert" : "none",
    run: (tx, scope, ctx) => findViolations(tx, code, scope, ctx),
  })),
});

import { dictReferencesPort } from "../kernel/index.js";
import { profileDictReferences } from "./dict-references.js";
