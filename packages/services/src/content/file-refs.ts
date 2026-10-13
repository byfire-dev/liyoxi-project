import { implementKeyed, fileRefTypePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
const dramaReleasable = async (tx: Tx, id: string) => {
  const row = await tx.drama.findUnique({ where: { id }, select: { archivedAt: true } });
  return !!row && row.archivedAt !== null;
};
const proofReleasable = async (tx: Tx, id: string) => {
  const row = await tx.drama.findUnique({
    where: { id },
    select: { firstListedAt: true, archivedAt: true },
  });
  return !!row && (row.firstListedAt === null || row.archivedAt !== null);
};
export const contentFileRefs = [
  implementKeyed(fileRefTypePort, "drama_episode_master", {
    roles: { main: { categories: ["drama_master"], retentionDays: 180 } },
    inUse: async (tx, fileId) =>
      (
        await tx.dramaEpisodeMaster.findMany({
          where: { fileId, isCurrent: true, state: "ready", drama: { archivedAt: null } },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "main" })),
    readColumns: async (tx) =>
      (
        await tx.dramaEpisodeMaster.findMany({
          where: { drama: { archivedAt: null } },
          select: { id: true, fileId: true },
        })
      ).map((row) => ({
        refId: row.id,
        fileId: row.fileId,
        role: "main",
      })),
  }),
  implementKeyed(fileRefTypePort, "drama", {
    roles: { poster: { categories: ["poster"], retentionDays: 90, canRelease: dramaReleasable } },
    inUse: async (tx, fileId) =>
      (
        await tx.drama.findMany({
          where: { posterFileId: fileId, archivedAt: null },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "poster" })),
    readColumns: async (tx) =>
      (
        await tx.drama.findMany({
          where: { posterFileId: { not: null }, archivedAt: null },
          select: { id: true, posterFileId: true },
        })
      ).map((row) => ({ refId: row.id, fileId: row.posterFileId!, role: "poster" })),
  }),
  implementKeyed(fileRefTypePort, "drama_permit", {
    inUse: async (tx, fileId) =>
      (
        await tx.dramaPermit.findMany({
          where: {
            scanFileIds: { has: fileId },
            drama: { archivedAt: null },
            OR: [{ status: "active" }, { drama: { firstListedAt: { not: null } } }],
          },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "scan" })),
    roles: {
      scan: {
        categories: ["drama_license_doc"],
        retentionDays: 30,
        canRelease: async (tx, id) => {
          const row = await tx.dramaPermit.findUnique({ where: { id }, select: { dramaId: true } });
          return !!row && proofReleasable(tx, row.dramaId);
        },
      },
    },
    readColumns: async (tx) =>
      (
        await tx.dramaPermit.findMany({
          where: { status: "active", drama: { archivedAt: null } },
          select: { id: true, scanFileIds: true },
        })
      ).flatMap((row) =>
        row.scanFileIds.map((fileId) => ({ refId: row.id, fileId, role: "scan" })),
      ),
  }),
  implementKeyed(fileRefTypePort, "drama_copyright", {
    inUse: async (tx, fileId) =>
      (
        await tx.dramaCopyright.findMany({
          where: { proofFileIds: { has: fileId }, drama: { archivedAt: null } },
          select: { dramaId: true },
        })
      ).map((row) => ({ fileId, refId: row.dramaId, role: "proof" })),
    roles: {
      proof: { categories: ["drama_license_doc"], retentionDays: 30, canRelease: proofReleasable },
    },
    readColumns: async (tx) =>
      (
        await tx.dramaCopyright.findMany({
          where: { drama: { archivedAt: null } },
          select: { dramaId: true, proofFileIds: true },
        })
      ).flatMap((row) =>
        row.proofFileIds.map((fileId) => ({ refId: row.dramaId, fileId, role: "proof" })),
      ),
  }),
  implementKeyed(fileRefTypePort, "drama_copyright_revision", {
    // 不借修订的历史身份绕过现有法定证明释放规则：剧目未归档时仍保留证明。
    inUse: async (tx, fileId) =>
      (
        await tx.dramaCopyrightRevision.findMany({
          where: { proofFileIds: { has: fileId }, drama: { archivedAt: null } },
          select: { id: true },
        })
      ).map((row) => ({ fileId, refId: row.id, role: "proof" })),
    roles: {
      proof: {
        categories: ["drama_license_doc"],
        retentionDays: 1095,
        canRelease: async (tx, id) => {
          const row = await tx.dramaCopyrightRevision.findUnique({
            where: { id },
            select: { dramaId: true },
          });
          return !!row && dramaReleasable(tx, row.dramaId);
        },
      },
    },
    readColumns: async (tx) =>
      (
        await tx.dramaCopyrightRevision.findMany({
          where: { drama: { archivedAt: null } },
          select: { id: true, proofFileIds: true },
        })
      ).flatMap((row) =>
        row.proofFileIds.map((fileId) => ({ refId: row.id, fileId, role: "proof" })),
      ),
  }),
];
