import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { revisionsWorld } from "./revisions.test-world.js";
import type { RevisionsWorld } from "./revisions.test-world.js";
const db = useSeededDatabase("services");
let h: RevisionsWorld;
beforeAll(async () => {
  h = await revisionsWorld(db);
}, 180000);
afterAll(async () => {
  await h?.media.jobs.shutdown();
});
it("草稿只改版权自身版本，移出proof释放30天；曾上架即使delisted也拒绝replace", async () => {
  const { d, snapshot, file } = await h.drama(),
    next = await h.proof();
  await h.tx.run((t) =>
    h.copyright.replace(t, h.actor.identity, d.id, {
      ...snapshot,
      proofFileIds: [next.id],
      lockVersion: 0,
    }),
  );
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).lockVersion).toBe(0);
  expect(
    (await h.prisma.dramaCopyright.findUniqueOrThrow({ where: { dramaId: d.id } })).lockVersion,
  ).toBe(1);
  expect(
    await h.prisma.fileRef.findFirstOrThrow({
      where: { fileId: file.id, refType: "drama_copyright" },
    }),
  ).toMatchObject({
    state: "released",
    keepUntil: new Date(h.clock.now().getTime() + 30 * 86_400_000),
  });
  const ended = await h.drama("delisted");
  await expect(
    h.tx.run((t) =>
      h.copyright.replace(t, h.actor.identity, ended.d.id, { ...ended.snapshot, lockVersion: 0 }),
    ),
  ).rejects.toMatchObject({ error: "COPYRIGHT_REVISION_REQUIRED" });
});
it("修订append-only、旧proof永久保留；延期和范围变化一次各发一个事实", async () => {
  const { d, snapshot, file, revisionId } = await h.drama("delisted"),
    next = await h.proof(),
    evidence = await h.proof();
  const initial = await h.prisma.dramaCopyrightRevision.findUniqueOrThrow({
    where: { id: revisionId! },
  });
  const id = await h.tx.run((t) =>
    h.copyright.revise(t, h.actor.identity, d.id, {
      lockVersion: 0,
      changeKind: "extend",
      copyright: {
        ...snapshot,
        licenseEndDate: "2028-12-31",
        platforms: ["douyin"],
        proofFileIds: [next.id],
      },
      reason: "真实范围与期限同时变更",
      revisionProofFileIds: [evidence.id],
      confirm: { prevEndDate: snapshot.licenseEndDate },
    }),
  );
  expect(
    await h.prisma.dramaCopyrightRevision.findUniqueOrThrow({ where: { id: revisionId! } }),
  ).toEqual(initial);
  expect(
    await h.prisma.fileRef.count({ where: { fileId: file.id, refType: "drama_copyright" } }),
  ).toBe(1);
  expect(
    await h.prisma.fileRef.count({
      where: { fileId: evidence.id, refType: "drama_copyright_revision", refId: id },
    }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: {
        aggregateId: d.id,
        eventType: { in: ["drama.license_extended", "drama.license_scope_changed"] },
      },
    }),
  ).toBe(2);
  expect(
    await h.prisma.timer.count({
      where: { subjectId: d.id, kind: "content.license_end", status: "scheduled" },
    }),
  ).toBe(0);
});
it("确认/版本/无差异/错误类型和所有缩短拒绝零修订、零事件", async () => {
  const { d, snapshot } = await h.drama("delisted"),
    file = await h.proof(),
    base = {
      lockVersion: 0,
      changeKind: "correction" as const,
      copyright: snapshot,
      reason: "法律依据",
      revisionProofFileIds: [file.id],
      confirm: { prevEndDate: snapshot.licenseEndDate },
    };
  for (const [patch, error] of [
    [{ lockVersion: 7 }, "VERSION_CONFLICT"],
    [{ confirm: { prevEndDate: "2027-12-30" } }, "CONFIRM_MISMATCH"],
    [{}, "COPYRIGHT_NO_CHANGE"],
    [
      { copyright: { ...snapshot, platforms: [...snapshot.platforms].reverse() } },
      "COPYRIGHT_NO_CHANGE",
    ],
    [
      { changeKind: "extend", copyright: { ...snapshot, territory: "新地域" } },
      "COPYRIGHT_CHANGE_KIND_MISMATCH",
    ],
    [{ copyright: { ...snapshot, licenseEndDate: "2027-12-30" } }, "LICENSE_SHORTEN_NOT_OPEN"],
    [
      { changeKind: "shorten", copyright: { ...snapshot, licenseEndDate: "2027-12-30" } },
      "LICENSE_SHORTEN_NOT_OPEN",
    ],
  ] as const) {
    await expect(
      h.tx.run((t) => h.copyright.revise(t, h.actor.identity, d.id, { ...base, ...patch })),
    ).rejects.toMatchObject({ error });
  }
  await expect(
    h.tx.run((t) =>
      h.copyright.revise(t, h.actor.identity, d.id, {
        ...base,
        changeKind: "extend",
        copyright: { ...snapshot, territory: "新地域" },
      }),
    ),
  ).rejects.toMatchObject({
    error: "COPYRIGHT_CHANGE_KIND_MISMATCH",
    details: { allowedKinds: ["scope_change", "correction"] },
  });
  expect(await h.prisma.dramaCopyrightRevision.count({ where: { dramaId: d.id } })).toBe(1);
  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: d.id } })).toBe(0);
});
it("listed修订真实上架校验失败，版权/历史/引用/事件整体回滚", async () => {
  const { d, snapshot } = await h.drama("listed"),
    file = await h.proof(),
    before = await h.prisma.dramaCopyright.findUniqueOrThrow({ where: { dramaId: d.id } });
  await expect(
    h.tx.run((t) =>
      h.copyright.revise(t, h.actor.identity, d.id, {
        lockVersion: 0,
        changeKind: "extend",
        copyright: { ...snapshot, licenseEndDate: "2028-12-31" },
        reason: "续约",
        revisionProofFileIds: [file.id],
        confirm: { prevEndDate: snapshot.licenseEndDate },
      }),
    ),
  ).rejects.toMatchObject({ error: "LISTING_CHECK_FAILED" });
  expect(await h.prisma.dramaCopyright.findUniqueOrThrow({ where: { dramaId: d.id } })).toEqual(
    before,
  );
  expect(await h.prisma.dramaCopyrightRevision.count({ where: { dramaId: d.id } })).toBe(1);
  expect(await h.prisma.fileRef.count({ where: { fileId: file.id } })).toBe(0);
});
it("许可复核仅true可清、剧目版本递增一次；错误proof/归档受控拒绝", async () => {
  const { d, snapshot } = await h.drama();
  await h.prisma.drama.update({ where: { id: d.id }, data: { isPermitRecheckRequired: true } });
  await h.tx.run((t) =>
    h.copyright.confirmPermit(t, h.actor.identity, d.id, { note: "已核原许可" }),
  );
  expect(await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
    isPermitRecheckRequired: false,
    lockVersion: 1,
  });
  await expect(
    h.tx.run((t) => h.copyright.confirmPermit(t, h.actor.identity, d.id, {})),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  const wrong = await h.make.fileObject();
  await expect(
    h.tx.run((t) =>
      h.copyright.replace(t, h.actor.identity, d.id, {
        ...snapshot,
        proofFileIds: [wrong.id],
        lockVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  const archived = await h.drama("delisted");
  await h.prisma.drama.update({
    where: { id: archived.d.id },
    data: { archivedAt: h.clock.now() },
  });
  await expect(
    h.tx.run((t) =>
      h.copyright.replace(t, h.actor.identity, archived.d.id, {
        ...archived.snapshot,
        lockVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({
    error: "DRAMA_ARCHIVED",
    details: { archivedAt: h.clock.now().toISOString() },
  });
});
