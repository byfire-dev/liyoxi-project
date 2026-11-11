import type { PrismaClient } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import {
  claimLicenseRevision,
  completeLicenseRevision,
  correctLicenseLetter,
  voidLicenseLetter,
} from "../../docs/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import { createRuntimeDocsLicense } from "../../ops/index.js";
import type { Runtime } from "../../runtime.js";
import type { Keyring } from "../../security/index.js";
import type { Factories } from "../data/factories/index.js";
import { fakeUscc } from "../data/factories/context.js";

/** Historical upstream order/account inputs only. No license pointer, ready flag or proof is inserted. */
export async function preparePortalPreviewLicense(input: {
  db: PrismaClient;
  runtime: Runtime;
  clock: Clock;
  make: Factories;
  keyring: Keyring;
  entityId: string;
  storeId: string;
  merchantUserId: string;
  termId: string;
  dramaId: string;
}) {
  const { db, runtime: r, clock, make } = input,
    now = clock.now();
  const staff = await make.staff({ staffRoleKey: "super_admin" });
  await db.paramValue.create({
    data: {
      id: uuidv7(),
      key: "platform.legal_entity",
      value: { name: "电脑验真测试平台（虚构）", creditCode: fakeUscc(900001) },
      effectiveAt: now,
      createdAt: now,
      createdByStaffId: staff.id,
      reason: "隔离测试虚构法定输入，非真实签章或法务验收",
    },
  });
  const channelId = uuidv7();
  await db.channelAccount.create({
    data: {
      id: channelId,
      entityId: input.entityId,
      storeId: input.storeId,
      platform: "douyin",
      accountName: "电脑验真测试账号",
      accountUid: channelId,
      accountUidNorm: channelId,
      status: "available",
      accountType: "personal",
      submittedAt: now,
      verifiedAt: now,
      verifiedByStaffId: staff.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const licenseDeps = createRuntimeDocsLicense({
    clock,
    flow: r.flow,
    events: r.events,
    portalOrigin: r.env.PORTAL_PUBLIC_ORIGIN!,
    keyring: () => input.keyring,
  });
  const system = createIdentityContext({ actor: { type: "system", job: "lyxtest.portal_verify" } });
  const finish = async (revisionId: string) => {
    const claim = await r.tx.run((tx) => claimLicenseRevision(tx, r.docsRender.queue, revisionId));
    if (!claim || claim.entityId !== input.entityId)
      throw new Error("PREVIEW_LICENSE_CLAIM_FAILED");
    // State-transport PDF bytes only: not a rendered, formally stamped or legally accepted artifact.
    const file = await r.media.putSystemFile({
      category: "legal_doc",
      fileName: "verification.pdf",
      body: Buffer.from(`%PDF-1.7\n% portal state transport ${revisionId}\n%%EOF`),
      objectKey: `legal/portal-preview/${revisionId}.pdf`,
      entityId: input.entityId,
      storeId: null,
    });
    const completed = await r.tx.run((tx) =>
      completeLicenseRevision(tx, r.docsRender.queue, claim, {
        fileId: file.fileId,
        pdfSha256: file.sha256,
        signMode: "stamp",
        platformSignedAt: clock.now(),
      }),
    );
    if (!completed) throw new Error("PREVIEW_LICENSE_COMPLETION_FAILED");
  };
  const create = async (expired: boolean, issued: boolean) => {
    const order = await make.dramaOrder({
      entityId: input.entityId,
      storeId: input.storeId,
      placedByUserId: input.merchantUserId,
      subscriptionTermId: input.termId,
      status: "live",
    });
    const day = calendarDate(now);
    const item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: input.dramaId,
      phase: "live",
      usageStartDate: new Date(`${addDays(day, expired ? -30 : -1)}T00:00:00Z`),
      usageEndDate: new Date(`${addDays(day, expired ? -1 : 30)}T00:00:00Z`),
    });
    await db.orderItemAccount.create({
      data: {
        orderItemId: item.id,
        channelAccountId: channelId,
        platform: "douyin",
        createdAt: now,
      },
    });
    await r.tx.run((tx) => r.licenseLetters.reconcileLetters(tx, [item.id], "portal-live:preview"));
    const letter = await db.licenseLetter.findFirstOrThrow({
      where: { orderItemId: item.id },
      include: { revisions: { orderBy: { revNo: "desc" } } },
    });
    if (
      letter.entityId !== input.entityId ||
      letter.storeId !== input.storeId ||
      letter.revisions.length !== 1
    )
      throw new Error("PREVIEW_LICENSE_SCOPE_INVALID");
    if (issued) await finish(letter.revisions[0]!.id);
    return { id: letter.id, code: letter.verifyCode };
  };
  const current = await create(false, true),
    expired = await create(true, true),
    unissued = await create(false, false);
  let pending: { revisionId: string; revNo: number } | undefined;
  let corrections = 0;
  let voided = false;
  return {
    async queueCorrection() {
      if (pending || voided || corrections >= 2) throw new Error("PREVIEW_LICENSE_ACTION_INVALID");
      // Change only the owned historical source, then let the real writer compare/freeze it.
      await db.entity.update({
        where: { id: input.entityId },
        data: { name: `电脑验真更正测试主体${corrections + 1}`, updatedAt: clock.now() },
      });
      pending = await r.tx.run((tx) =>
        correctLicenseLetter(tx, licenseDeps, system, {
          licenseLetterId: current.id,
          correctionKinds: ["licensee_name"],
          note: "隔离验真资料更正",
        }),
      );
      corrections++;
    },
    async completeCorrection() {
      if (!pending || voided) throw new Error("PREVIEW_LICENSE_ACTION_INVALID");
      await finish(pending.revisionId);
      pending = undefined;
    },
    async void() {
      if (voided) throw new Error("PREVIEW_LICENSE_ACTION_INVALID");
      await r.tx.run((tx) =>
        voidLicenseLetter(tx, licenseDeps, system, {
          licenseLetterId: current.id,
          note: "隔离验真作废，不代表真实撤销",
        }),
      );
      voided = true;
    },
    async facts() {
      const projection = await r.licenseVerification.get({ code: current.code });
      return {
        verifyCode: current.code,
        revNo: projection.currentRevision.revNo,
        pendingRevNo: pending?.revNo ?? null,
        displayStatus: projection.displayStatus,
        expiredVerifyCode: expired.code,
        unissuedVerifyCode: unissued.code,
      };
    },
  };
}
