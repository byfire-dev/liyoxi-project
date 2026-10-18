// W1-21：接口级单一主路径。CLI 与 Vitest 共用，不载入 Vitest，不直接查写数据库。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COMPARE_FIELDS } from "@liyoxi/contract";
import type { M1Support, M1Scope, M1MediaScope, M1HttpObjectIO } from "@liyoxi/services/testing";
import { activateM1Staff, bootstrapM1Admin } from "./m1-auth.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";
import type { M1Result } from "./runner-api.js";
import type { M1Api } from "./in-process.js";

export interface M1ChainReport {
  readonly runId: string;
  readonly orderNo: string;
  readonly paymentOrderNo: string;
  readonly episodeCount: number;
  readonly chargePoints: number;
  readonly spendablePoints: number;
  readonly final: {
    readonly order: string;
    readonly item: string;
    readonly ticket: string;
    readonly isLive: boolean;
  };
  readonly invariants: {
    readonly status: string;
    readonly checksRun: number;
    readonly violationsFound: number;
    readonly errors: number;
  };
  readonly steps: readonly { readonly name: string; readonly elapsedMs: number }[];
  readonly elapsedMs: number;
}
export interface M1ChainInput {
  readonly api: M1Api;
  readonly support: M1Support;
  readonly say?: (message: string) => void;
  /** M1 默认仍为二十集、四路；后续里程碑可用小剧验证新增机制。 */
  readonly episodeCount?: number;
  readonly uploadConcurrency?: number;
  readonly seedDemo?: (admin: M1AuthenticatedStaff) => ReturnType<M1Support["seedDemo"]>;
  /** 混跑两遍各自的真实身份输入；默认 M1 数据与步骤保持原样。 */
  readonly merchantIdentity?: {
    readonly loginCode: string;
    readonly phoneCode: string;
    readonly uscc: string;
  };
  readonly bootstrapAdmin?: (api: M1Api) => Promise<M1AuthenticatedStaff>;
  readonly reviewerPhone?: string;
  readonly externalIO?: M1HttpObjectIO;
  readonly qualificationDoc?: (
    context: M1ChainContext & {
      readonly qualificationDocId: string;
      readonly fileId: string;
      readonly result: M1Result<"m.qualificationDoc.create">;
    },
  ) => Promise<void>;
  readonly beforeOrder?: (context: M1ChainContext) => Promise<readonly string[]>;
  readonly beforeEpisodes?: (
    context: M1ChainContext & { readonly scope: M1Scope },
  ) => Promise<void>;
  readonly afterChain?: (
    context: M1ChainContext & { readonly scope: M1Scope; readonly sampleId: string },
  ) => Promise<void>;
}
export interface M1ChainContext {
  readonly api: M1Api;
  readonly support: M1Support;
  readonly admin: M1AuthenticatedStaff;
  readonly reviewer: M1AuthenticatedStaff;
  readonly owner: {
    readonly entityId: string;
    readonly storeId: string;
    readonly merchantUserId: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}
const image = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);
// 虚构统一社会信用代码；完整校验位，避免把单包的跳过校验夹具带入主链。
function fakeUscc() {
  const prefix = "91310000MA1K00001",
    chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  return (
    prefix +
    chars[
      (31 -
        ([...prefix].reduce((sum, char, i) => sum + chars.indexOf(char) * weights[i]!, 0) % 31)) %
        31
    ]
  );
}
const localDate = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

export async function runM1Chain({
  api,
  support,
  say = () => {},
  episodeCount = 20,
  uploadConcurrency = 4,
  seedDemo,
  merchantIdentity,
  bootstrapAdmin = bootstrapM1Admin,
  reviewerPhone = "19900000002",
  externalIO,
  qualificationDoc,
  beforeOrder,
  beforeEpisodes,
  afterChain,
}: M1ChainInput): Promise<M1ChainReport> {
  assert.equal(api.support, support, "API 与 worker 必须共用同一支架/时钟");
  assert.ok(Number.isInteger(episodeCount) && episodeCount >= 1 && episodeCount <= 20);
  assert.ok(
    Number.isInteger(uploadConcurrency) && uploadConcurrency >= 1 && uploadConcurrency <= 4,
  );
  const started = performance.now(),
    steps: { name: string; elapsedMs: number }[] = [];
  const call = createM1Caller(api);
  async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    say(name);
    const at = performance.now(),
      value = await run();
    const elapsedMs = Math.round(performance.now() - at);
    steps.push({ name, elapsedMs });
    say(`${name}：完成（${elapsedMs}毫秒）`);
    return value;
  }
  const actors = await step("后台真实引导、激活、登录与二次验证", async () => {
    const admin = await bootstrapAdmin(api);
    const seeded = await (seedDemo ? seedDemo(admin) : support.seedDemo());
    // staff.I6 requires an active lead in every nonempty group, including the bootstrap group.
    const members = (await call("admin.staff.list", admin.headers, { query: { limit: 100 } }))
      .items;
    for (const groupId of new Set(
      members.flatMap((member) => (member.staffGroup ? [member.staffGroup.staffGroupId] : [])),
    )) {
      const group = members.filter((member) => member.staffGroup?.staffGroupId === groupId);
      if (group.some((member) => member.status === "active" && member.isLead)) continue;
      const candidate = group.find((member) => member.status === "active");
      assert.ok(candidate, "M1 非空员工组必须有真实启用成员可担任主管");
      const detail = await call("admin.staff.get", admin.headers, {
        params: { staffId: candidate.staffId },
      });
      const updated = await call("admin.staff.update", admin.headers, {
        params: { staffId: candidate.staffId },
        body: { isLead: true, lockVersion: detail.lockVersion, ackNoLead: false },
      });
      assert.equal(updated.isLead, true);
      assert.equal(updated.staffGroup?.staffGroupId, groupId);
    }
    const manager = seeded.staff.find((s) => s.key === "delivery_manager");
    assert.ok(manager?.activation, "干净演示库必须产出交付经理激活码");
    const reviewer = await activateM1Staff(api, {
      phone: reviewerPhone,
      staffId: manager.staffId,
      activationCode: manager.activation.code,
    });
    assert.notEqual(admin.staffId, reviewer.staffId, "生产上传与质检须为两个真实员工");
    await support.drainEvents();
    return { admin, reviewer };
  });
  const admin = actors.admin.headers,
    reviewer = actors.reviewer.headers;
  const owner = await step("商家真实手机号登录、协议与主体门店", async () => {
    const agreements = await call("m.agreement.list", {}, { query: { scene: "login" } });
    const consents = agreements.items
      .filter((a) => a.subjectKind === "user" && a.currentVersion)
      .map((a) => ({
        agreementKey: a.agreementKey,
        agreementVersionId: a.currentVersion!.agreementVersionId,
      }));
    assert.equal(consents.length, 2);
    const loginCode = merchantIdentity?.loginCode ?? `m1-login-${support.runId}`,
      phoneCode = merchantIdentity?.phoneCode ?? `m1-phone-${support.runId}`;
    if (!merchantIdentity) {
      support.providers.wechat.sessions.set(loginCode, { openid: `oM1_${support.runId}` });
      support.providers.wechat.phones.set(phoneCode, "13700000121");
    }
    const login = await call(
      "m.session.phoneLogin",
      {},
      { body: { loginCode, phoneCode, consents } },
    );
    const userHeaders = { authorization: `Bearer ${login.token}`, "X-Client-Version": "1.0.0" };
    await call("m.bootstrap.get", userHeaders);
    // 同意走实际公开接口，不能仅在测试数据库补记录。
    await call("m.agreementConsent.create", userHeaders, { body: { consents } });
    const membership = await call("m.entity.create", userHeaders, { body: {} });
    assert.equal(membership.role, "owner");
    const headers = { ...userHeaders, "X-Store-Id": membership.storeId };
    const stores = await call("m.store.list", headers);
    assert.ok(stores.items.some((s) => s.storeId === membership.storeId));
    await support.drainEvents();
    const state = await support.readState(membership);
    assert.equal(state.store.qualificationStatus, "unsubmitted");
    assert.equal(state.wallet?.heldTotalQty, 0);
    return { ...membership, merchantUserId: login.me.user.merchantUserId, headers };
  });
  const headers = owner.headers;
  const context: M1ChainContext = { api, support, ...actors, owner };
  async function upload(
    registration: Pick<M1Result<"admin.file.create">, "mode" | "post" | "key" | "expiresAt">,
    bytes: Uint8Array,
  ) {
    assert.equal(registration.mode, "post");
    assert.ok(registration.post, "本轮实际存储必须签发直传表单");
    assert.equal(
      await (externalIO?.upload ?? support.providers.storage.upload)(
        {
          ...registration.post,
          key: registration.key,
          expiresAt: new Date(registration.expiresAt),
        },
        bytes,
      ),
      204,
      "实际表单直传必须成功",
    );
  }
  async function merchantFile(
    category: "profile_image" | "kyc_license" | "channel_screenshot" | "pay_receipt",
  ) {
    const registrations = await call("m.file.create", headers, {
      body: {
        category,
        ...(category === "kyc_license" ? { licenseKind: "business_license" as const } : {}),
        files: [
          {
            fileName: `${category}-${randomUUID()}.png`,
            sizeBytes: String(image.length),
            clientToken: randomUUID(),
          },
        ],
      },
    });
    const file = registrations.items[0];
    assert.ok(file);
    await upload(file, image);
    const complete = () =>
      call("m.file.complete", headers, { body: {}, params: { fileId: file.fileId } });
    if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
    else await complete();
    await support.promote(file.fileId);
    assert.equal(
      (await call("m.file.get", headers, { params: { fileId: file.fileId } })).status,
      "stored",
    );
    return file.fileId;
  }
  await step("四步建档、真实资质审核通过与交付经理指派", async () => {
    const logoFileId = await merchantFile("profile_image"),
      photos: string[] = [];
    for (let i = 0; i < 4; i++) photos.push(await merchantFile("profile_image"));
    const defaults = support.profileDefaults;
    const basic = await call("m.storeProfile.basic.get", headers);
    assert.equal(basic.viewerRole, "owner");
    const saved = await call("m.storeProfile.basic.update", headers, {
      body: {
        draft: false,
        lockVersion: basic.lockVersion,
        brandName: "M1演示品牌",
        logoFileId,
        storeName: `M1演示门店-${support.runId}`,
        industryCode: defaults.industryCode,
        categoryCode: defaults.categoryCode,
        address: { ...defaults.address },
        businessHours: [{ start: "09:00", end: "18:00" }],
        storeTel: "010-12345678",
        avgSpendFen: 10000,
      },
    });
    const media = await call("m.storeProfile.media.update", headers, {
      body: {
        draft: false,
        lockVersion: saved.lockVersion,
        groups: {
          door: [{ fileId: photos[0]! }],
          interior: photos.slice(1).map((fileId) => ({ fileId })),
        },
      },
    });
    const service = await call("m.storeProfile.service.update", headers, {
      body: {
        draft: false,
        lockVersion: media.lockVersion,
        serviceItems: [{ name: "门店标准服务", priceFen: 10000 }],
        sellingPointCodes: [...defaults.sellingPointCodes],
      },
    });
    await call("m.storeProfile.contact.update", headers, {
      body: { lockVersion: service.lockVersion, name: "演示联系人", phoneSource: "login" },
    });
    const draft = await call("m.storeProfile.qualification.update", headers, {
      body: { lockVersion: null, claimedEntityType: "enterprise" },
    });
    assert.equal(draft.viewerRole, "owner");
    if (draft.viewerRole !== "owner") throw new Error("资质必须为老板视图");
    assert.ok(draft.openRound);
    const licenseFileId = await merchantFile("kyc_license");
    const doc = await call("m.qualificationDoc.create", headers, {
      body: { docType: "business_license", fileId: licenseFileId },
    });
    await qualificationDoc?.({
      ...context,
      qualificationDocId: doc.doc.qualificationDocId,
      fileId: licenseFileId,
      result: doc,
    });
    await call("m.qualificationDoc.update", headers, {
      params: { qualificationDocId: doc.doc.qualificationDocId },
      body: {
        lockVersion: doc.lockVersion,
        fields: {
          name: "M1演示经营主体",
          uscc: merchantIdentity?.uscc ?? fakeUscc(),
          principal: "演示负责人",
          principalRole: "legal_rep",
          subjectType: "enterprise",
          validFrom: "2020-01-01",
          validTo: "long_term",
          address: "演示路一号",
        },
      },
    });
    const submitted = await call("m.storeProfile.qualification.submit", headers, {
      body: {
        qualificationSubmissionId: draft.openRound.qualificationSubmissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      },
    });
    assert.equal(submitted.storeQualificationStatus, "pending");
    const pending = await support.readState(owner);
    assert.equal(pending.store.qualificationStatus, "pending");
    const queue = await call("admin.approval.list", admin, {
      query: { kind: "qualification", storeId: owner.storeId },
    });
    assert.ok(queue.items.some((a) => a.domain.id === draft.openRound!.qualificationSubmissionId));
    const view = await call("admin.qualificationSubmission.get", admin, {
      params: { qualificationSubmissionId: draft.openRound.qualificationSubmissionId },
    });
    await call("admin.qualificationSubmission.approve", admin, {
      params: { qualificationSubmissionId: view.qualificationSubmissionId },
      body: {
        lockVersion: view.approval.lockVersion,
        mode: "normal",
        confirm: { roundNo: view.roundNo! },
        confirmChecks: view.confirmChecks,
      },
    });
    await call("admin.store.assignDeliveryManager", admin, {
      params: { storeId: owner.storeId },
      body: { toStaffId: actors.reviewer.staffId },
    });
    await support.drainEvents();
    const state = await support.readState(owner);
    assert.equal(state.entity.verificationStatus, "verified");
    assert.equal(state.store.qualificationStatus, "verified");
    assert.equal(state.store.deliveryManagerId, actors.reviewer.staffId);
    assert.equal(state.qualifications.filter((q) => q.outcome === "approved").length, 1);
  });
  const channelAccountId = await step("订剧前绑定渠道账号并真实核验通过", async () => {
    const account = await call("m.channelAccount.create", headers, {
      body: {
        platform: "douyin",
        accountName: "M1演示门店账号",
        accountUid: `m1_${support.runId}`,
        accountType: "none",
        screenshotFileIds: [await merchantFile("channel_screenshot")],
      },
    });
    // create 实际已提交首轮；submit 是驳回后的重提，主路径不制造一次驳回。
    const queue = await call("admin.approval.list", admin, {
      query: { kind: "channel_account", storeId: owner.storeId },
    });
    const approval = queue.items.find(
      (row) => row.kind === "channel_account" && row.domain.type === "channel_account_submission",
    );
    assert.ok(approval);
    const view = await call("admin.channelAccountSubmission.get", admin, {
      params: { channelAccountSubmissionId: approval.domain.id },
    });
    const checklist = await support.checklist("account.verify");
    await call("admin.channelAccountSubmission.approve", admin, {
      params: { channelAccountSubmissionId: view.channelAccountSubmissionId },
      body: {
        lockVersion: view.approval.lockVersion,
        confirm: { roundNo: view.roundNo, accountUid: account.accountUid },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        confirmChecks: view.approval.confirmChecks,
        checklistVersionNo: checklist.versionNo,
        results: checklist.items.map((item) => ({ key: item.key, result: "pass" as const })),
      },
    });
    const list = await call("m.channelAccount.list", headers);
    assert.equal(
      list.items.find((a) => a.channelAccountId === account.channelAccountId)?.status,
      "available",
    );
    await support.drainEvents();
    assert.equal((await support.readState(owner)).store.qualificationStatus, "verified");
    return account.channelAccountId;
  });
  const payment = await step("对公付款凭证、真实确认入账与订阅积分", async () => {
    const plans = await call("m.plan.list", headers);
    const basic = plans.items.find((p) => p.code === "basic");
    assert.ok(basic);
    const quote = await call("m.plan.quote", headers, {
      body: { planId: basic.planId, months: 1 },
    });
    const policy = await call("m.purchasePolicy.get", headers);
    assert.ok(policy.channels.some((c) => c.code === "bank_transfer" && c.isEnabled));
    const agreements = await call("m.agreement.list", headers, {
      query: { scene: "plan_purchase" },
    });
    const order = await call("m.paymentOrder.create", headers, {
      body: {
        planId: quote.planId,
        months: 1,
        channel: "bank_transfer",
        expectAmountFen: quote.payFen,
        agreementVersionIds: agreements.items
          .filter((a) => a.currentVersion)
          .map((a) => a.currentVersion!.agreementVersionId),
      },
    });
    const proof = await call("m.paymentOrder.transferProof.create", headers, {
      params: { paymentOrderId: order.paymentOrderId },
      body: { fileId: await merchantFile("pay_receipt") },
    });
    assert.ok(proof.latestTransferProof);
    const proofId = proof.latestTransferProof.transferProofId;
    const queue = await call("admin.transferProof.list", admin, {
      query: { tab: "pending", q: order.orderNo },
    });
    assert.ok(queue.items.some((p) => p.transferProofId === proofId));
    const view = await call("admin.transferProof.get", admin, {
      params: { transferProofId: proofId },
    });
    await call("admin.transferProof.confirm", admin, {
      params: { transferProofId: proofId },
      body: {
        lockVersion: view.lockVersion,
        bankSerialNo: `M1-${support.runId}`,
        confirmChecks: ["bank_statement_checked"],
        confirm: { orderNo: order.orderNo, receivedAmountFen: order.amountFen },
      },
    });
    await support.drainEvents();
    const state = await support.readState({ ...owner, paymentOrderId: order.paymentOrderId });
    assert.equal(state.payment?.status, "paid");
    assert.equal(state.payment?.fulfillmentStatus, "done");
    assert.equal(state.wallet?.subStatus, "active");
    assert.equal(state.wallet?.planAvailableQty, quote.benefits.monthlyPoints);
    assert.equal(state.wallet?.heldTotalQty, 0);
    const wallet = await call("m.wallet.get", headers);
    assert.equal(wallet.subscription.status, "active");
    assert.equal(wallet.points.spendablePoints, quote.benefits.monthlyPoints);
    return {
      paymentOrderId: order.paymentOrderId,
      orderNo: order.orderNo,
      grantedPoints: quote.benefits.monthlyPoints,
    };
  });
  const referenceStoreAssetIds = [...((await beforeOrder?.(context)) ?? [])];
  const purchased = await step(
    `订购实际${episodeCount}集演示剧，认领具名到期定时器并真实开工`,
    async () => {
      const dramas = await call("m.drama.list", headers);
      const drama = dramas.items.find((d) => d.totalEpisodes === episodeCount);
      assert.ok(drama, `演示主链必须选真实${episodeCount}集剧，不缩改订单集数`);
      await call("m.cartItem.create", headers, { body: { dramaId: drama.dramaId } });
      const quote = await call("m.order.quote", headers, {
        body: {
          dramaIds: [drama.dramaId],
          channelAccountIds: [channelAccountId],
          isTopModel: false,
        },
      });
      assert.deepEqual(quote.blockers, []);
      const order = await call("m.order.create", headers, {
        body: {
          dramaIds: [drama.dramaId],
          channelAccountIds: [channelAccountId],
          focusCodes: ["CF01"],
          ...(referenceStoreAssetIds.length ? { referenceStoreAssetIds } : {}),
          isTopModel: false,
          expectedLaunchDate: quote.earliestLaunchDate,
          agreementVersionId: quote.agreement.agreementVersionId,
          expect: quote.expect,
        },
      });
      const scope = { ...owner, orderId: order.orderId };
      const held = await support.readState(scope);
      assert.equal(held.order?.status, "pending_start");
      assert.equal(held.holds.filter((h) => h.status === "held").length, 1);
      assert.equal(held.wallet?.heldTotalQty, quote.totalChargePoints);
      const timer = await support.orderTimer(scope);
      const afterFire = new Date(
        Math.max(support.clock.now().getTime(), timer.fireAt.getTime()) + 1,
      );
      if (api.waitUntil) await api.waitUntil(afterFire);
      else support.clock.set(afterFire);
      const fired = await support.runDueTimer(scope, timer.timerId);
      assert.equal(fired.outcome, "fired");
      assert.ok(fired.dispatchNo > 0);
      await support.drainEvents();
      const state = await support.readState(scope);
      assert.equal(state.order?.status, "producing");
      assert.equal(state.items.length, 1);
      assert.equal(state.items[0]?.episodeCount, episodeCount);
      assert.equal(state.tickets.length, 1);
      assert.equal(state.plans.length, 1);
      assert.equal(state.holds[0]?.status, "captured");
      assert.equal(state.wallet?.heldTotalQty, 0);
      const tickets = await call("admin.deliveryTicket.list", admin, {
        query: { orderId: order.orderId, tab: "all" },
      });
      assert.equal(tickets.items.length, 1);
      await call("admin.order.get", admin, { params: { orderId: order.orderId } });
      const fullScope: M1Scope = {
        ...scope,
        orderItemId: state.items[0]!.id,
        deliveryTicketId: state.tickets[0]!.id,
      };
      return {
        scope: fullScope,
        orderNo: order.orderNo,
        chargePoints: quote.totalChargePoints,
        deliveryPlanId: state.plans[0]!.id,
        launchDate: quote.earliestLaunchDate,
      };
    },
  );
  const scope = purchased.scope,
    ticketParams = { deliveryTicketId: scope.deliveryTicketId };
  async function checks(
    code: "qc.sample" | "qc.episode" | "qc.package" | "delivery.precheck" | "launch.verify",
  ) {
    const template = await support.checklist(code);
    return {
      checklistVersionNo: template.versionNo,
      results: template.items.map((item) => ({ key: item.key, result: "pass" as const })),
    };
  }
  async function finishProduction(
    fileId: string,
    category: M1MediaScope["category"],
    episodeNo: number,
  ) {
    await support.promote(fileId);
    await support.finishProduction(fileId, {
      ...scope,
      uploaderId: actors.admin.staffId,
      category,
      episodeNo,
    });
    assert.equal((await call("admin.file.get", admin, { params: { fileId } })).status, "stored");
  }
  async function productionFile(
    category: M1MediaScope["category"],
    episodeNo: number,
    finish = true,
  ) {
    const file = await call("admin.file.create", admin, {
      body: {
        category,
        storeId: owner.storeId,
        fileName: `m1-${support.runId}-${category}-${episodeNo}.mp4`,
        mime: "video/mp4",
        sizeBytes: String(support.productionVideo.sizeBytes),
        clientToken: randomUUID(),
        production: {
          kind: category === "sample_video" ? "sample" : "final",
          orderItemId: scope.orderItemId,
          episodeNo,
          aiUsage: { used: false, tools: [] },
        },
      },
    });
    await upload(file, support.productionVideo.bytes);
    const complete = () =>
      call("admin.file.complete", admin, { body: {}, params: { fileId: file.fileId } });
    if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
    else await complete();
    if (finish) await finishProduction(file.fileId, category, episodeNo);
    return file.fileId;
  }
  const sampleId = await step("交付方案推送确认，双人样片质检与实际签名保存后确认", async () => {
    const planParams = { deliveryPlanId: purchased.deliveryPlanId };
    const plan = await call("admin.deliveryPlan.get", admin, { params: planParams });
    const saved = await call("admin.deliveryPlan.draft.replace", admin, {
      params: planParams,
      body: {
        draftLockVersion: plan.draftLockVersion,
        content: {
          focusCodes: ["CF01"],
          referenceAssetIds: referenceStoreAssetIds,
          note: "突出门店特色与服务体验",
          launchMode: "merchant_self",
          items: [
            {
              orderItemId: scope.orderItemId,
              channelAccountIds: [channelAccountId],
              placements: [],
              agreedLaunchDate: purchased.launchDate,
              expectedDeliveryDate: localDate(support.clock.now()),
            },
          ],
        },
      },
    });
    const pushed = await call("admin.deliveryPlan.push", admin, {
      params: planParams,
      body: { draftLockVersion: saved.draftLockVersion },
    });
    await call("m.deliveryPlan.confirm", headers, {
      params: planParams,
      body: { versionNo: pushed.currentVersionNo },
    });
    assert.equal((await support.readState(scope)).ticket?.step, "sample_making");
    const sample = await call("admin.deliveryTicket.sample.create", admin, {
      params: ticketParams,
      body: { fileId: await productionFile("sample_video", 1), adSlots: [] },
    });
    const sampleParams = { sampleId: sample.sampleId };
    await call("admin.sample.inspect", reviewer, {
      params: sampleParams,
      body: await checks("qc.sample"),
    });
    await call("admin.sample.push", admin, { params: sampleParams, body: {} });
    const signed = await call("m.sample.downloadUrls", headers, { params: sampleParams, body: {} });
    const actual = externalIO
      ? await externalIO.readSigned(signed.url)
      : support.providers.storage.fetch(signed.url);
    assert.equal(actual.status, 200);
    if (actual.status !== 200) throw new Error("实际样片签名不能读取");
    assert.deepEqual(actual.body, support.productionVideo.bytes);
    await call("m.sample.confirm", headers, {
      params: sampleParams,
      body: { versionNo: sample.versionNo, viewedVia: "album", hasViewed: true },
    });
    await support.drainEvents();
    const state = await support.readState({ ...scope, sampleId: sample.sampleId });
    assert.equal(state.sample?.status, "confirmed");
    assert.ok(state.sample?.firstViewedAt);
    assert.equal(state.ticket?.step, "batch_compose");
    return sample.sampleId;
  });
  await beforeEpisodes?.({ ...context, scope });
  await step(`完整${episodeCount}集真实登记、逐集质检、成片包质检和推送`, async () => {
    const items: { episodeNo: number; fileId: string; variant: "common" }[] = [];
    // complete 的生产短轮询仍生效；只使用约定并发，整批结束才允许清理资源。
    for (let firstEpisode = 1; firstEpisode <= episodeCount; firstEpisode += uploadConcurrency) {
      const batch = await Promise.allSettled(
        Array.from(
          { length: Math.min(uploadConcurrency, episodeCount - firstEpisode + 1) },
          async (_unused, offset) => {
            const episodeNo = firstEpisode + offset;
            return {
              episodeNo,
              fileId: await productionFile("final_episode", episodeNo, false),
              variant: "common" as const,
            };
          },
        ),
      );
      const failures = batch.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "成片文件上传失败",
        );
      for (const result of batch) {
        if (result.status === "fulfilled") {
          // 上传结束后按序驱动有界执行器和事件分发器。
          await finishProduction(result.value.fileId, "final_episode", result.value.episodeNo);
          items.push(result.value);
        }
      }
    }
    const registered = await call("admin.deliveryTicket.episodeOutput.create", admin, {
      params: ticketParams,
      body: {
        items,
        ...(referenceStoreAssetIds.length ? { adoptedStoreAssetIds: referenceStoreAssetIds } : {}),
      },
    });
    assert.equal(registered.items.length, episodeCount);
    const quality = await checks("qc.episode");
    await call("admin.deliveryTicket.inspectEpisodes", reviewer, {
      params: ticketParams,
      body: {
        episodeOutputIds: registered.items.map((e) => e.episodeOutputId),
        checklistVersionNo: quality.checklistVersionNo,
        defaultResults: quality.results,
      },
    });
    await call("admin.deliveryTicket.inspectPackage", reviewer, {
      params: ticketParams,
      body: await checks("qc.package"),
    });
    assert.equal((await support.readState(scope)).ticket?.step, "delivering");
    await call("admin.deliveryTicket.pushPackage", admin, {
      params: ticketParams,
      body: { precheck: await checks("delivery.precheck") },
    });
    await support.drainEvents();
    const state = await support.readState(scope);
    assert.equal(state.ticket?.step, "awaiting_launch");
    assert.equal(state.item?.phase, "to_launch");
    assert.equal(state.launchTasks.length, 1);
    const release = await call("m.orderItem.release.get", headers, {
      params: { orderItemId: scope.orderItemId },
    });
    assert.equal(release?.episodeCount, episodeCount);
    assert.equal(release?.episodes.length, episodeCount);
    assert.equal(release?.isDownloadable, true);
  });
  const launchTaskId = await step("实际逐集签名下载、商家回填与后台通过核验", async () => {
    for (let episodeNo = 1; episodeNo <= episodeCount; episodeNo++) {
      const download = await call("m.orderItem.downloadUrls", headers, {
        params: { orderItemId: scope.orderItemId },
        body: { kind: "episode", episodeNo },
      });
      const fetched = externalIO
        ? await externalIO.readSigned(download.url)
        : support.providers.storage.fetch(download.url);
      assert.equal(fetched.status, 200);
      if (fetched.status !== 200) throw new Error("实际成片签名不能读取");
      assert.deepEqual(fetched.body, support.productionVideo.bytes);
      assert.ok(fetched.contentDisposition?.startsWith("attachment;"));
    }
    const tasks = await call("m.launchTask.list", headers, {
      query: { orderItemId: scope.orderItemId },
    });
    const matching = tasks.items
      .flatMap((order) => order.items)
      .filter((item) => item.orderItemId === scope.orderItemId)
      .flatMap((item) => item.tasks);
    assert.equal(matching.length, 1);
    const id = matching[0]!.launchTaskId;
    await call("m.launchTask.submit", headers, {
      params: { launchTaskId: id },
      body: {
        linkKind: "collection",
        collectionUrl: `https://example.invalid/m1/${support.runId}`,
        reportedEpisodeCount: episodeCount,
        actualLaunchDate: localDate(support.clock.now()),
      },
    });
    const ticket = await call("admin.deliveryTicket.get", admin, { params: ticketParams });
    const submissionId = ticket.launch.tasks.find(
      (t) => t.launchTaskId === id,
    )?.currentLaunchSubmissionId;
    assert.ok(submissionId);
    const view = await call("admin.launchSubmission.get", admin, {
      params: { launchSubmissionId: submissionId },
    });
    await call("admin.launchSubmission.approve", admin, {
      params: { launchSubmissionId: submissionId },
      body: {
        lockVersion: view.approval.lockVersion,
        confirm: { roundNo: view.roundNo, reportedEpisodeCount: episodeCount },
        confirmChecks: view.approval.confirmChecks,
        verifiedEpisodeCount: episodeCount,
        ...(await checks("launch.verify")),
      },
    });
    await support.drainEvents();
    return id;
  });
  return step("真实终态与全量不变量零违规", async () => {
    const state = await support.readState({
      ...scope,
      sampleId,
      launchTaskId,
      paymentOrderId: payment.paymentOrderId,
    });
    const item = await call("m.orderItem.get", headers, {
      params: { orderItemId: scope.orderItemId },
    });
    assert.equal(item.phase, "live");
    assert.equal(item.ticketStep, "in_service");
    assert.equal(item.episodeCount, episodeCount);
    assert.equal(item.liveEpisodeCount, episodeCount);
    assert.equal(item.usageStartDate, localDate(support.clock.now()));
    assert.equal(state.order?.status, "live");
    assert.equal(state.item?.phase, "live");
    assert.equal(state.item?.liveEpisodeCount, episodeCount);
    assert.ok(state.item?.usageStartDate);
    assert.equal(state.ticket?.step, "in_service");
    assert.equal(state.launchTask?.isLive, true);
    assert.equal(state.wallet?.heldTotalQty, 0);
    assert.equal(state.wallet?.planAvailableQty, payment.grantedPoints - purchased.chargePoints);
    assert.equal(state.holds.filter((h) => h.status === "captured").length, 1);
    const wallet = await call("m.wallet.get", headers);
    assert.equal(wallet.subscription.status, "active");
    assert.equal(wallet.points.heldPoints, 0);
    assert.equal(wallet.points.spendablePoints, payment.grantedPoints - purchased.chargePoints);
    await afterChain?.({ ...context, scope, sampleId });
    const invariants = await support.fullInvariants();
    assert.equal(invariants.status, "succeeded");
    assert.equal(invariants.violationsFound, 0);
    assert.deepEqual(invariants.errors, []);
    return {
      runId: support.runId,
      orderNo: purchased.orderNo,
      paymentOrderNo: payment.orderNo,
      episodeCount,
      chargePoints: purchased.chargePoints,
      spendablePoints: state.wallet!.planAvailableQty,
      final: {
        order: state.order!.status,
        item: state.item!.phase,
        ticket: state.ticket!.step,
        isLive: state.launchTask!.isLive,
      },
      invariants: {
        status: invariants.status,
        checksRun: invariants.checksRun,
        violationsFound: invariants.violationsFound,
        errors: invariants.errors.length,
      },
      steps,
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}
