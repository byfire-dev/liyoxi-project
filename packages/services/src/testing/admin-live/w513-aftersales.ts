// Owned private live preparation only. All money, order starts and PDF outcomes use real writers.
import { createHash } from "node:crypto";
import { z } from "zod";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { PrismaClient } from "@liyoxi/db";
import { demoImage } from "../../content/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Runtime } from "../../runtime.js";
import type { OrderActor } from "../../order/index.js";
import { assertProfileComplete } from "../../profile/index.js";
import { createLedgerHarness, dumpLedger, openTerm, priceDrama } from "../billing.js";
import type { LedgerHarness } from "../billing.js";
import { createClock } from "../clock.js";
import { M1_LICENSE_TEST_INPUTS, prepareM1LicenseInputs } from "../m1-license-inputs.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

export const W513AftersalesScopeSchema = z.strictObject({
  runId: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string(),
  prefix: z.string(),
  startedAt: z.iso.datetime(),
  entityId: z.uuid(),
  storeId: z.uuid(),
  merchantUserId: z.uuid(),
  memberId: z.uuid(),
  requesterId: z.uuid(),
  financeId: z.uuid(),
});
export type W513AftersalesScope = z.infer<typeof W513AftersalesScopeSchema>;
export function parseW513AftersalesContext(raw: unknown, contextPath: string, root: string) {
  const parsed = z
      .object({
        fixtures: z.object({
          fixtures: z.object({
            w513: z.object({ aftersales: z.object({ scope: W513AftersalesScopeSchema }) }),
          }),
        }),
      })
      .parse(raw),
    scope = parsed.fixtures.fixtures.w513.aftersales.scope;
  if (
    contextPath !== `${root.replace(/\/$/, "")}/admin-live-${scope.runId}/context.json` ||
    scope.name !== `lyx_test_admin_live_${scope.runId}` ||
    scope.prefix !== `lyx:test:admin_live_${scope.runId}:`
  )
    throw new Error("W513P2拒绝其他检出或轮次");
  return scope;
}
const title = (scope: W513AftersalesScope, kind: "取消" | "授权") =>
  `W513P2${kind}短剧-${scope.runId}`;
const posterKey = (scope: W513AftersalesScope) => `poster/w513-p2/${scope.runId}.png`;

export async function assertW513AftersalesScope(runtime: Runtime, raw: unknown) {
  const scope = W513AftersalesScopeSchema.parse(raw),
    live = assertDeliveryLiveEnvironment(runtime.env),
    startedAt = new Date(scope.startedAt);
  if (
    live.runId !== scope.runId ||
    live.name !== scope.name ||
    live.prefix !== scope.prefix ||
    startedAt > runtime.clock.now() ||
    scope.requesterId === scope.financeId
  )
    throw new Error("W513P2运行范围不符");
  await runtime.tx.run(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: scope.entityId } }),
      store = await tx.store.findUniqueOrThrow({ where: { id: scope.storeId } }),
      member = await tx.entityMember.findUniqueOrThrow({ where: { id: scope.memberId } }),
      requester = await tx.staff.findUniqueOrThrow({ where: { id: scope.requesterId } }),
      finance = await tx.staff.findUniqueOrThrow({ where: { id: scope.financeId } });
    if (
      ![`W513售后主体-${scope.runId}`, `W513售后主体-${scope.runId}更正`].includes(
        entity.name ?? "",
      ) ||
      entity.createdByUserId !== scope.merchantUserId ||
      entity.createdAt < startedAt ||
      store.name !== `W513售后门店-${scope.runId}` ||
      store.entityId !== entity.id ||
      store.createdAt < startedAt ||
      member.entityId !== entity.id ||
      member.merchantUserId !== scope.merchantUserId ||
      member.role !== "owner" ||
      member.status !== "active" ||
      requester.staffRoleKey !== "super_admin" ||
      requester.status !== "active" ||
      finance.staffRoleKey !== "finance" ||
      finance.name !== "W513取消审批财务" ||
      finance.status !== "active" ||
      !finance.totpEnrolledAt ||
      !finance.passwordHash ||
      finance.createdAt < startedAt
    )
      throw new Error("W513P2主体、门店或实际演员归属不符");
  });
  return scope;
}

function owner(scope: W513AftersalesScope): OrderActor {
  return {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: scope.merchantUserId, client: "weapp", role: "owner" },
      entityId: scope.entityId,
      storeId: scope.storeId,
    }),
    membership: {
      memberId: scope.memberId,
      entityId: scope.entityId,
      storeId: scope.storeId,
      role: "owner",
      storeMode: "active",
    },
  };
}

/** Same legal initial profile inputs as the public order fixture, with this live domain's names.
 * The public fixture's W115F/“主推服务” collides with the already registered W119F sibling name.
 * Preserve existing facts and fill missing input, including media/services; never skip an incomplete row.
 */
async function prepareOwnedProfile(
  runtime: Runtime,
  db: PrismaClient,
  h: LedgerHarness,
  actor: OrderActor,
) {
  const { entityId, storeId } = actor.membership,
    now = runtime.clock.now();
  const dicts = [
    {
      dictTypeKey: "industry",
      code: "W513P2I",
      name: "W513P2测试行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "W513P2C",
      name: "W513P2测试品类",
      parentCode: "W513P2I",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    ...["W513P2P", "W513P2M", "W513P2D"].map((code, index) => ({
      dictTypeKey: "region",
      code,
      name: code,
      parentCode: index ? ["W513P2P", "W513P2M"][index - 1]! : null,
      ext: { level: index + 1, functionalZone: false, opened: true },
    })),
    {
      dictTypeKey: "custom_focus",
      code: "W513P2F",
      name: "W513P2主推服务",
      parentCode: null,
      ext: {},
    },
  ];
  for (const item of dicts)
    await db.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: item.dictTypeKey, code: item.code } },
      create: {
        id: uuidv7(),
        ...item,
        isEnabled: true,
        position: 999,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
  const current = await db.storeProfile.findUnique({ where: { storeId } });
  if (current && current.entityId !== entityId) throw new Error("W513P2档案主体不符");
  const data = {
    brandName: current?.brandName || "W513P2测试品牌",
    industryCode: current?.industryCode || "W513P2I",
    categoryCode: current?.categoryCode || "W513P2C",
    provinceCode: current?.provinceCode || "W513P2P",
    cityCode: current?.cityCode || "W513P2M",
    districtCode: current?.districtCode || "W513P2D",
    addressDetail: current?.addressDetail || "测试路一号",
    businessHours:
      Array.isArray(current?.businessHours) && current.businessHours.length
        ? current.businessHours
        : [{ start: "09:00", end: "18:00" }],
    storeTel: current?.storeTel || "01012345678",
    avgSpendFen: current?.avgSpendFen ?? 1000,
    sellingPointCodes: current?.sellingPointCodes.length ? current.sellingPointCodes : ["service"],
    updatedAt: now,
  };
  await db.storeProfile.upsert({
    where: { storeId },
    create: { storeId, entityId, ...data, createdAt: now },
    update: data,
  });
  for (const [mediaGroup, required] of [
    ["door", 1],
    ["interior", 3],
  ] as const) {
    const existing = await db.storeProfileMedia.findMany({
      where: { entityId, storeId, mediaGroup, removedAt: null },
      select: { position: true },
      orderBy: { position: "desc" },
    });
    const lastPosition = existing[0]?.position ?? 0;
    for (let index = existing.length; index < required; index++) {
      const file = await h.make.fileObject({
        category: "profile_image",
        bucket: "asset",
        entityId,
        storeId,
        scopeType: "store",
      });
      await db.storeProfileMedia.create({
        data: {
          id: uuidv7(),
          entityId,
          storeId,
          fileId: file.id,
          mediaGroup,
          position: lastPosition + index - existing.length + 1,
          mediaKind: "image",
          createActorType: "merchant",
          createActorId: actor.ctx.actor.id!,
          createClient: "weapp",
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }
  if (!(await db.storeServiceItem.count({ where: { entityId, storeId, removedAt: null } })))
    await db.storeServiceItem.create({
      data: {
        id: uuidv7(),
        entityId,
        storeId,
        name: "W513P2主推服务",
        priceFen: 1000,
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
  await runtime.tx.run((tx) => assertProfileComplete(tx, storeId));
}

/** Discover exactly the two owned real orders, never the P1 flow or another file's orders. */
export async function readW513AftersalesOrders(runtime: Runtime, scope: W513AftersalesScope) {
  await assertW513AftersalesScope(runtime, scope);
  return runtime.tx.run(async (tx) => {
    const rows = await tx.orderItem.findMany({
      where: {
        entityId: scope.entityId,
        storeId: scope.storeId,
        createdAt: { gte: new Date(scope.startedAt) },
        drama: { title: { in: [title(scope, "取消"), title(scope, "授权")] } },
        dramaOrder: { placedByUserId: scope.merchantUserId },
      },
      include: { drama: true, dramaOrder: true, pointHold: true, deliveryTicket: true },
    });
    if (rows.length !== 2 || rows[0]!.dramaOrderId === rows[1]!.dramaOrderId)
      throw new Error("W513P2需要两笔独立真实订购");
    const cancel = rows.find((row) => row.drama.title === title(scope, "取消")),
      license = rows.find((row) => row.drama.title === title(scope, "授权"));
    if (!cancel || !license) throw new Error("W513P2订单集合不符");
    for (const row of rows) {
      if (
        row.dramaOrder.entityId !== scope.entityId ||
        row.dramaOrder.storeId !== scope.storeId ||
        row.dramaOrder.createdAt < new Date(scope.startedAt) ||
        row.pointHold.refType !== "order_item" ||
        row.pointHold.refId !== row.id ||
        row.pointHold.entityId !== scope.entityId ||
        row.pointHold.storeId !== scope.storeId ||
        row.pointHold.qty !== row.chargePoints ||
        !row.pointHold.capturedAt ||
        !row.deliveryTicket ||
        row.deliveryTicket.orderItemId !== row.id
      )
        throw new Error("W513P2真实开工或冻结引用不符");
    }
    return { cancel, license };
  });
}

/** No hidden staff factory calls, no global parameter changes, no cancellation seed writes. */
export async function prepareW513Aftersales(
  runtime: Runtime,
  db: PrismaClient,
  raw: unknown,
  observe: (step: string) => void = () => {},
) {
  observe("PREPARE_SCOPE");
  const scope = await assertW513AftersalesScope(runtime, raw),
    h = createLedgerHarness(db, { clock: createClock(runtime.clock.now()) }),
    actor = owner(scope);
  observe("PREPARE_EXISTING");
  const existing = await db.dramaOrder.count({ where: { entityId: scope.entityId } });
  if (existing) {
    if (existing !== 2) throw new Error("W513P2拒绝部分准备或额外订单，不复造替身");
    observe("PREPARE_REUSE");
    return preparedW513Aftersales(runtime, scope, [], true);
  }
  observe("PREPARE_PROFILE");
  await prepareOwnedProfile(runtime, db, h, actor);
  observe("PREPARE_GRANT");
  await openTerm(h, { entityId: scope.entityId, planCode: "pro" });
  observe("PREPARE_POSTER");
  const poster = await runtime.media.putSystemFile({
    category: "poster",
    fileName: "w513-p2-poster.png",
    body: demoImage([90, 140, 165]),
    objectKey: posterKey(scope),
    entityId: null,
    storeId: null,
  });
  const channelAccountId = uuidv7(),
    now = runtime.clock.now();
  observe("PREPARE_ACCOUNT");
  await db.channelAccount.create({
    data: {
      id: channelAccountId,
      entityId: scope.entityId,
      storeId: scope.storeId,
      platform: "douyin",
      accountName: `W513P2授权号-${scope.runId}`,
      accountUid: channelAccountId,
      accountUidNorm: channelAccountId,
      accountType: "personal",
      status: "available",
      submittedAt: now,
      verifiedAt: now,
      verifiedByStaffId: scope.requesterId,
      createdAt: now,
      updatedAt: now,
    },
  });
  observe("PREPARE_AGREEMENT");
  const agreement =
    (await db.agreementVersion.findFirst({
      where: { agreementKey: "custom_license", status: "active" },
      orderBy: { effectiveAt: "desc" },
    })) ?? (await h.make.agreementVersion({ createdByStaffId: scope.requesterId }));
  const timers = [];
  for (const kind of ["取消", "授权"] as const) {
    observe(kind === "取消" ? "PREPARE_CANCEL_DRAMA" : "PREPARE_LICENSE_DRAMA");
    const drama = await h.make.drama({
      title: title(scope, kind),
      totalEpisodes: 2,
      dramaClass: "class_3",
      heatTier: "A",
      genreCodes: ["comedy"],
      posterFileId: poster.fileId,
      allowedPlacements: ["opening", "ending"],
      isAiGenerated: false,
      createdByStaffId: scope.requesterId,
      updatedByStaffId: scope.requesterId,
    });
    observe("PREPARE_COPYRIGHT");
    await db.dramaCopyright.create({
      data: {
        dramaId: drama.id,
        platforms: ["douyin"],
        territory: "中国大陆",
        licenseStartDate: new Date(`${calendarDate(now)}T00:00:00Z`),
        licenseEndDate: new Date(`${addDays(calendarDate(now), 365)}T00:00:00Z`),
        createdAt: now,
        updatedAt: now,
      },
    });
    observe("PREPARE_PERMIT");
    await db.dramaPermit.create({
      data: {
        id: uuidv7(),
        dramaId: drama.id,
        platform: "all",
        permitKind: "program_no",
        permitNo: `W513P2-${kind}-${scope.runId}`,
        status: "active",
        createdByStaffId: scope.requesterId,
        createdAt: now,
        updatedAt: now,
      },
    });
    observe("PREPARE_PRICE");
    await priceDrama(h, { dramaId: drama.id, points: 120, staffId: scope.requesterId });
    observe("PREPARE_QUOTE");
    const quote = await runtime.order.quote(actor, {
      dramaIds: [drama.id],
      channelAccountIds: [channelAccountId],
      isTopModel: false,
    });
    if (quote.agreement.agreementVersionId !== agreement.id)
      throw new Error("W513P2当前协议不一致");
    observe("PREPARE_CREATE");
    const created = await runtime.order.create(actor, {
      dramaIds: [drama.id],
      channelAccountIds: [channelAccountId],
      focusCodes: ["W513P2F"],
      isTopModel: false,
      agreementVersionId: quote.agreement.agreementVersionId,
      expect: quote.expect,
    });
    observe("PREPARE_START_TIMER");
    const timer = await db.timer.findFirstOrThrow({
        where: { kind: "order.start", subjectId: created.orderId, status: "scheduled" },
      }),
      handler = runtime.assembly.timerHandler("order.start");
    if (!handler) throw new Error("W513P2缺少真实开工handler");
    const payload = timer.payload;
    if (payload !== null && (typeof payload !== "object" || Array.isArray(payload)))
      throw new Error("W513P2开工timer载荷不符");
    // ROOT-approved test composition: deliver this owned timer early at the current real clock.
    // No future clock, global delay change, timer-row rewrite or bypass of the owner handler.
    observe("PREPARE_START_OWNER");
    const result = await runtime.tx.run((tx) =>
      handler.handle(tx, {
        id: timer.id,
        kind: timer.kind,
        subjectType: timer.subjectType,
        subjectId: timer.subjectId,
        payload,
      }),
    );
    if (result !== "fired") throw new Error("W513P2真实开工handler未完成");
    observe("PREPARE_START_VERIFY");
    const order = await db.dramaOrder.findUniqueOrThrow({ where: { id: created.orderId } });
    if (order.status !== "producing" || !order.startedAt || order.startedAt > runtime.clock.now())
      throw new Error("W513P2真实开工时间或状态不符");
    timers.push({
      orderId: order.id,
      timerId: timer.id,
      scheduledFireAt: timer.fireAt.toISOString(),
      actualStartedAt: order.startedAt.toISOString(),
      handlerResult: result,
      earlyDelivery: true,
    });
  }
  observe("PREPARE_LICENSE_INPUTS");
  await runtime.tx.run((tx) =>
    prepareM1LicenseInputs({
      db: tx,
      clock: runtime.clock,
      env: runtime.env,
      inputs: M1_LICENSE_TEST_INPUTS,
    }),
  );
  observe("PREPARE_LICENSE_REFS");
  const orders = await readW513AftersalesOrders(runtime, scope);
  observe("PREPARE_LICENSE_ENSURE");
  await runtime.tx.run((tx) =>
    runtime.licenseLetters.ensureLetters(tx, [orders.license.id], `guard-w513p2-${scope.runId}`),
  );
  observe("PREPARE_PROOF");
  return preparedW513Aftersales(runtime, scope, timers, false);
}

async function preparedW513Aftersales(
  runtime: Runtime,
  scope: W513AftersalesScope,
  timers: {
    orderId: string;
    timerId: string;
    scheduledFireAt: string;
    actualStartedAt: string;
    handlerResult: string;
    earlyDelivery: boolean;
  }[],
  alreadyPrepared: boolean,
) {
  const orders = await readW513AftersalesOrders(runtime, scope);
  const refs = await runtime.tx.run(async (tx) => {
    const accounts = await tx.orderItemAccount.findMany({
        where: { orderItemId: { in: [orders.cancel.id, orders.license.id] } },
        select: { channelAccountId: true },
      }),
      account = await tx.billingAccount.findUniqueOrThrow({ where: { entityId: scope.entityId } });
    if (
      accounts.length !== 2 ||
      accounts[0]!.channelAccountId !== accounts[1]!.channelAccountId ||
      !account.currentSubscriptionTermId
    )
      throw new Error("W513P2真实账号或入账周期不符");
    return {
      channelAccountId: accounts[0]!.channelAccountId,
      subscriptionTermId: account.currentSubscriptionTermId,
    };
  });
  const dto = (row: typeof orders.cancel) => ({
    orderId: row.dramaOrderId,
    itemId: row.id,
    orderNo: row.dramaOrder.orderNo,
    dramaId: row.dramaId,
    pointHoldId: row.pointHoldId,
    chargePoints: row.chargePoints,
    ticketId: row.deliveryTicket!.id,
  });
  return {
    scope,
    cancel: dto(orders.cancel),
    license: dto(orders.license),
    ...refs,
    alreadyPrepared,
    timers,
    proof: await readW513AftersalesProof(runtime, scope),
  };
}

/** Read-only actual ledger/balance/request facts, never quote-derived expected return amounts. */
export async function readW513AftersalesProof(runtime: Runtime, scope: W513AftersalesScope) {
  const orders = await readW513AftersalesOrders(runtime, scope);
  return runtime.tx.run(async (tx) => ({
    ledger: await dumpLedger(tx, scope.entityId),
    cancelInput: {
      orderId: orders.cancel.dramaOrderId,
      itemId: orders.cancel.id,
      chargePoints: orders.cancel.chargePoints,
      pointHoldId: orders.cancel.pointHoldId,
    },
    operations: await tx.ledgerOperation.findMany({
      where: { entityId: scope.entityId },
      select: {
        id: true,
        opKey: true,
        opType: true,
        pointHoldId: true,
        refType: true,
        refId: true,
        planDeltaQty: true,
        addonDeltaQty: true,
        spendableAfterQty: true,
        heldAfterQty: true,
      },
      orderBy: { seq: "asc" },
    }),
    requests: await tx.cancelRequest.findMany({
      where: {
        entityId: scope.entityId,
        storeId: scope.storeId,
        dramaOrderId: orders.cancel.dramaOrderId,
      },
      select: {
        id: true,
        status: true,
        executedAt: true,
        executedByStaffId: true,
        totalBasePoints: true,
        totalDeductPoints: true,
        totalRefundPoints: true,
        approvalRequest: {
          select: { id: true, requesterStaffId: true, decidedByStaffId: true, status: true },
        },
        cancelRequestLines: {
          select: {
            id: true,
            targetId: true,
            chargePoints: true,
            priorRequestedPoints: true,
            deductPoints: true,
            refundPoints: true,
            returnedPoints: true,
            convertedPoints: true,
            forfeitedPoints: true,
            executedAt: true,
            resultSnapshot: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    letters: await tx.licenseLetter.findMany({
      where: { orderItemId: orders.license.id, entityId: scope.entityId, storeId: scope.storeId },
      select: {
        id: true,
        letterNo: true,
        status: true,
        currentRevisionId: true,
        revisions: {
          select: {
            id: true,
            revNo: true,
            renderStatus: true,
            renderAttemptNo: true,
            fileId: true,
            pdfSha256: true,
            signMode: true,
          },
          orderBy: { revNo: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  }));
}

export async function renderW513Aftersales(
  runtime: Runtime,
  scope: W513AftersalesScope,
  fail = false,
) {
  const { license } = await readW513AftersalesOrders(runtime, scope);
  const revisions = await runtime.tx.run((tx) =>
    tx.licenseLetterRevision.findMany({
      where: {
        renderStatus: "queued",
        createdAt: { gte: new Date(scope.startedAt) },
        licenseLetter: {
          orderItemId: license.id,
          entityId: scope.entityId,
          storeId: scope.storeId,
          status: { not: "voided" },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 10,
    }),
  );
  if (!revisions.length || revisions.length > 2) throw new Error("W513P2需要明确待渲染版次");
  for (const revision of revisions) {
    // Real renderer failure keeps the owner's original four-attempt limit. No status is seeded.
    for (let attempt = 0; attempt < (fail ? 4 : 1); attempt++)
      await runtime.docsRender.process({ revisionId: revision.id });
    const row = await runtime.tx.run((tx) =>
      tx.licenseLetterRevision.findUniqueOrThrow({
        where: { id: revision.id },
        include: { file: true, licenseLetter: true },
      }),
    );
    if (fail) {
      if (row.renderStatus !== "failed" || row.renderAttemptNo !== 4 || row.fileId)
        throw new Error("W513P2真实字体故障未达到原失败预算");
      continue;
    }
    const file = row.file;
    if (
      row.renderStatus !== "ready" ||
      row.licenseLetter.currentRevisionId !== row.id ||
      !file ||
      row.signMode !== "platform_cert" ||
      !row.certIssuer ||
      !row.certSerial ||
      !row.platformSignedAt ||
      file.category !== "legal_doc" ||
      file.bucket !== "secure" ||
      file.entityId !== scope.entityId ||
      file.storeId !== null ||
      file.sha256 !== row.pdfSha256
    )
      throw new Error("W513P2实际PDF未ready或归属不符");
    const bytes = await runtime.providers.storage.readObject({
      bucket: "secure",
      key: file.objectKey,
      maxBytes: 1048576,
    });
    if (
      !bytes.ok ||
      Buffer.from(bytes.value.subarray(0, 5)).toString() !== "%PDF-" ||
      createHash("sha256").update(bytes.value).digest("hex") !== row.pdfSha256
    )
      throw new Error("W513P2实际PDF字节不符");
  }
  return {
    processedRevisionIds: revisions.map((row) => row.id),
    failed: fail,
    technicalTestCertificate: !fail,
    proof: await readW513AftersalesProof(runtime, scope),
  };
}

/** Fictional initial metadata change only; the UI must call the real correction writer. */
export async function changeW513LicenseInput(runtime: Runtime, scope: W513AftersalesScope) {
  await readW513AftersalesOrders(runtime, scope);
  const name = `W513售后主体-${scope.runId}更正`;
  await runtime.tx.run(async (tx) => {
    const before = await tx.entity.findUniqueOrThrow({ where: { id: scope.entityId } });
    if (before.name !== `W513售后主体-${scope.runId}`)
      throw new Error("W513P2名称资料只能更正一次");
    await tx.entity.update({
      where: { id: scope.entityId },
      data: { name, updatedAt: runtime.clock.now() },
    });
  });
  return { entityId: scope.entityId, changedField: "name", name };
}

export async function cleanupW513Aftersales(runtime: Runtime, scope: W513AftersalesScope) {
  await assertW513AftersalesScope(runtime, scope);
  const files = await runtime.tx.run(async (tx) => {
    const items = await tx.orderItem.findMany({
      where: {
        entityId: scope.entityId,
        storeId: scope.storeId,
        createdAt: { gte: new Date(scope.startedAt) },
        drama: { title: title(scope, "授权") },
        dramaOrder: { placedByUserId: scope.merchantUserId },
      },
      select: { id: true },
    });
    return tx.fileObject.findMany({
      where: {
        createdAt: { gte: new Date(scope.startedAt) },
        OR: [
          {
            category: "legal_doc",
            entityId: scope.entityId,
            licenseLetterRevisions: {
              some: {
                licenseLetter: {
                  storeId: scope.storeId,
                  entityId: scope.entityId,
                  orderItemId: { in: items.map((row) => row.id) },
                },
              },
            },
          },
          { category: "poster", objectKey: posterKey(scope), entityId: null, storeId: null },
        ],
      },
      select: {
        id: true,
        bucket: true,
        objectKey: true,
        entityId: true,
        storeId: true,
        uploadActorType: true,
        scopeType: true,
        sha256: true,
        licenseLetterRevisions: { select: { id: true, pdfSha256: true } },
      },
    });
  });
  for (const file of files) {
    const isPoster = file.objectKey === posterKey(scope);
    if (
      isPoster
        ? file.bucket !== "pub" ||
          file.scopeType !== "platform" ||
          file.entityId !== null ||
          file.storeId !== null ||
          file.uploadActorType !== "system"
        : file.bucket !== "secure" ||
          file.scopeType !== "entity" ||
          file.entityId !== scope.entityId ||
          file.storeId !== null ||
          !file.licenseLetterRevisions.length ||
          file.licenseLetterRevisions.some(
            (revision) =>
              revision.pdfSha256 !== file.sha256 ||
              !file.objectKey.startsWith("license/") ||
              !file.objectKey.includes(`/${revision.id}/`),
          )
    )
      throw new Error("W513P2清理对象元数据不符");
    const deleted = await runtime.providers.storage.delete({
      bucket: isPoster ? "pub" : "secure",
      key: file.objectKey,
    });
    if (!deleted.ok) throw new Error("W513P2本轮对象清理失败");
  }
  return { cleanedFiles: files.length };
}
