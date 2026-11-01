// 旧交付夹具的法定输入与 owner 状态运输；不是 PDF 排版、字库、签章或法务验收。
import { createHash } from "node:crypto";
import { permitCovers } from "@liyoxi/shared/catalog";
import { latestLicenseRenderClaimLease } from "../audit/index.js";
import { paramsAt } from "../config/index.js";
import {
  claimLicenseRevision,
  completeLicenseRevision,
  readLicenseReadiness,
  reconcileLetters,
} from "../docs/index.js";
import type { LicenseRenderQueueDeps } from "../docs/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import { uuidv7 } from "../kernel/index.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import type { Media } from "../media/index.js";
import type { Keyring } from "../security/index.js";
import { fakeUscc } from "./data/factories/context.js";
import { TEST_KEYRING } from "./data/seal.js";
import { createRuntimeDocsLicense } from "./ops-runtime.js";

export function createHistoricalLicenseReady(input: {
  tx: TxRunner;
  clock: Clock;
  flow: Flow;
  events: Pick<Events, "emit">;
  media: Pick<Media, "link" | "putSystemFile">;
  keyring?: () => Keyring;
}) {
  const deps = createRuntimeDocsLicense({
    ...input,
    portalOrigin: "https://portal.example.invalid",
    keyring: input.keyring ?? (() => TEST_KEYRING),
  });
  const queue: LicenseRenderQueueDeps = {
    ...deps,
    readLastClaimLease: latestLicenseRenderClaimLease,
    files: {
      async assertAndLink(tx, value) {
        await input.media.link(tx, {
          fileId: value.fileId,
          refType: "license_letter_revision",
          refId: value.revisionId,
          role: "pdf",
          entityId: value.entityId,
          storeId: value.storeId,
        });
        const [file] = await readMaterialFileFacts(tx, [value.fileId]);
        if (
          !file ||
          file.scopeType !== "entity" ||
          file.entityId !== value.entityId ||
          file.storeId !== null ||
          file.category !== "legal_doc" ||
          file.ext !== "pdf" ||
          file.sha256 !== value.sha256 ||
          file.status !== "stored" ||
          file.moderationState === "block" ||
          file.deletedAt ||
          file.erasedAt
        )
          throw new Error("历史夹具授权书文件不符合实际 owner 完成前置");
      },
    },
  };
  async function assertTestScope(tx: Tx) {
    const [database] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!database?.name.startsWith("lyx_test_"))
      throw new Error("历史授权夹具只允许本轮隔离测试库");
  }
  /** Only missing upstream legal inputs. Never edits append-only consents or license state. */
  async function prepareInputs(ids: readonly string[]) {
    await input.tx.run(async (tx) => {
      await assertTestScope(tx);
      const now = input.clock.now();
      if (!(await paramsAt(tx, ["platform.legal_entity"], now))["platform.legal_entity"]) {
        const staff = await tx.staff.findFirstOrThrow({
          where: { staffRoleKey: "super_admin", status: "active" },
          orderBy: { id: "asc" },
        });
        await tx.paramValue.create({
          data: {
            id: uuidv7(),
            key: "platform.legal_entity",
            value: { name: "历史交付测试平台（虚构）", creditCode: fakeUscc(900002) },
            effectiveAt: now,
            createdAt: now,
            createdByStaffId: staff.id,
            reason: "历史交付测试的虚构法定输入，非授权就绪结果",
          },
        });
      }
      const items = await tx.orderItem.findMany({
        where: { id: { in: [...new Set(ids)] } },
        include: { drama: true, orderItemAccounts: true },
        orderBy: { id: "asc" },
      });
      if (items.length !== new Set(ids).size) throw new Error("历史授权夹具订单项不存在");
      for (const item of items) {
        const dramaClass = item.drama.dramaClass ?? "class_3";
        if (!item.drama.dramaClass)
          await tx.drama.update({ where: { id: item.dramaId }, data: { dramaClass } });
        const platforms = [...new Set(item.orderItemAccounts.map((account) => account.platform))];
        const copyright = await tx.dramaCopyright.findUnique({ where: { dramaId: item.dramaId } });
        if (!copyright) {
          await tx.dramaCopyright.create({
            data: {
              dramaId: item.dramaId,
              territory: "中国大陆（虚构测试范围）",
              platforms,
              licenseStartDate: new Date("2020-01-01"),
              licenseEndDate: item.usageEndDate,
              createdAt: now,
              updatedAt: now,
            },
          });
        } else if (
          !copyright.territory?.trim() ||
          platforms.some((p) => !copyright.platforms.includes(p))
        ) {
          await tx.dramaCopyright.update({
            where: { dramaId: item.dramaId },
            data: {
              ...(!copyright.territory?.trim() ? { territory: "中国大陆（虚构测试范围）" } : {}),
              platforms: [...new Set([...copyright.platforms, ...platforms])],
              updatedAt: now,
            },
          });
        }
        const permits = await tx.dramaPermit.findMany({
          where: { dramaId: item.dramaId, status: "active" },
        });
        for (const platform of platforms) {
          if (
            permitCovers(
              permits.map((p) => ({
                kind: p.permitKind,
                number: p.permitNo,
                platform: p.platform,
                status: p.status,
              })),
              platform,
              dramaClass,
            )
          )
            continue;
          await tx.dramaPermit.create({
            data: {
              id: uuidv7(),
              dramaId: item.dramaId,
              platform,
              permitKind: dramaClass === "class_3" ? "program_no" : "license_no",
              permitNo: `历史夹具虚构许可-${item.dramaId}-${platform}`,
              status: "active",
              createdByStaffId: item.drama.createdByStaffId,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
      }
    });
  }
  async function ensureLicenseReadiness(tx: Tx, ids: readonly string[], triggerRef: string) {
    await reconcileLetters(tx, deps, ids, triggerRef);
    const facts = await deps.facts.readLicenseFacts(tx, ids);
    if (facts.length !== new Set(ids).size) throw new Error("历史授权就绪目标缺失");
    return readLicenseReadiness(tx, facts, readMaterialFileFacts);
  }
  /** Explicit precondition outside delivery TX; legal/version changes require calling it again. */
  async function prepareReady(ids: readonly string[]) {
    const queued = await input.tx.run(async (tx) => {
      await assertTestScope(tx);
      await reconcileLetters(tx, deps, ids, "lyxtest:historical_delivery_ready");
      return tx.licenseLetterRevision.findMany({
        where: {
          licenseLetter: { orderItemId: { in: [...ids] }, status: { not: "voided" } },
          renderStatus: "queued",
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
    });
    for (const revision of queued) {
      const claim = await input.tx.run((tx) => claimLicenseRevision(tx, queue, revision.id));
      if (!claim) throw new Error("历史授权夹具未实际认领当前版次");
      // Owner-state transport sample only: deliberately not a rendered/validated PDF.
      const body = Buffer.from(
        `%PDF-1.7\n% historical owner-state transport fixture; NOT PDF acceptance\n${JSON.stringify(claim.snapshot)}\n%%EOF`,
      );
      const sha256 = createHash("sha256").update(body).digest("hex");
      const file = await input.media.putSystemFile({
        category: "legal_doc",
        fileName: `${claim.letterNo}.pdf`,
        body,
        objectKey: `legal/${claim.orderItemId}/${claim.letterNo.toLowerCase()}-r${claim.revNo}-${sha256}.pdf`,
        entityId: claim.entityId,
        storeId: null,
      });
      const completed = await input.tx.run((tx) =>
        completeLicenseRevision(tx, queue, claim, {
          fileId: file.fileId,
          pdfSha256: file.sha256,
          signMode: "stamp",
          platformSignedAt: input.clock.now(),
        }),
      );
      if (!completed) throw new Error("历史授权夹具当前认领未实际完成");
    }
    const result = await input.tx.run((tx) =>
      ensureLicenseReadiness(tx, ids, "lyxtest:historical_delivery_check"),
    );
    if (result.length !== new Set(ids).size || result.some((item) => !item.ready))
      throw new Error("历史授权夹具尚未满足实际就绪守卫");
  }
  return { prepareInputs, prepareReady, ensureLicenseReadiness };
}
